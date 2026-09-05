import { pool } from '../config/db.js';
import path from 'path';
import fs from 'fs';

// Helper: Calculate Suggested Score (0 to 6) based on Threshold Matrix
export function calculateSuggestedScore(actualValue, thresholdMatrix) {
    if (!thresholdMatrix || !thresholdMatrix.scale) return { suggestedScore: 0, label: 'N/A' };
    const numVal = parseFloat(actualValue);
    if (isNaN(numVal)) return { suggestedScore: 0, label: 'Invalid Value' };

    const scale = thresholdMatrix.scale;
    // Iterate from highest (6) to lowest (0)
    for (let score = 6; score >= 0; score--) {
        const bracket = scale[score.toString()];
        if (bracket && bracket.min !== undefined && bracket.max !== undefined) {
            const min = parseFloat(bracket.min);
            const max = parseFloat(bracket.max);
            if (numVal >= min && numVal <= max) {
                return { suggestedScore: score, label: bracket.label || `${score}/6` };
            }
        }
    }
    // Fallback: if lower than lowest min
    if (scale['0']) return { suggestedScore: 0, label: scale['0'].label || '< Target' };
    return { suggestedScore: 0, label: 'Below Range' };
}

// Helper: MARS Variable Pay & Increment Slab Matcher
export function calculateMarsSlab(finalWeightedScore) {
    const score = parseFloat(finalWeightedScore);
    if (isNaN(score)) return { slab: '0%', grade: 'No Benefit', description: 'Below Minimum Threshold (PIP)' };
    if (score >= 4.80) return { slab: '50%', grade: 'Outstanding', description: 'Exceptional Performance (50% Variable Pay)' };
    if (score >= 4.30) return { slab: '45%', grade: 'Exceeds Expectations', description: 'High Performance (45% Variable Pay)' };
    if (score >= 3.80) return { slab: '40%', grade: 'Meets Expectations', description: 'Solid Target Delivery (40% Variable Pay)' };
    if (score >= 3.30) return { slab: '35%', grade: 'Average', description: 'Acceptable Performance (35% Variable Pay)' };
    if (score >= 2.80) return { slab: '30%', grade: 'Needs Improvement', description: 'Sub-Par Performance (30% Variable Pay)' };
    return { slab: '0%', grade: 'Unsatisfactory', description: 'Below Minimum Benchmark (0% / PIP)' };
}

// ==================== CYCLES ====================
export async function getCycles(req, res) {
    try {
        const result = await pool.query('SELECT * FROM kra_cycles ORDER BY id DESC');
        res.status(200).json({ success: true, data: result.rows });
    } catch (err) {
        console.error("Error in getCycles:", err.message);
        res.status(500).json({ success: false, message: err.message });
    }
}

export async function createCycle(req, res) {
    try {
        const { financialYear, cycleName, startDate, endDate } = req.body;
        if (!financialYear || !cycleName) {
            return res.status(400).json({ success: false, message: "Financial year and cycle name are required" });
        }
        const result = await pool.query(`
            INSERT INTO kra_cycles (financial_year, cycle_name, start_date, end_date, status)
            VALUES ($1, $2, $3, $4, 'active')
            RETURNING *;
        `, [financialYear, cycleName, startDate || null, endDate || null]);
        res.status(201).json({ success: true, data: result.rows[0], message: "Cycle created successfully" });
    } catch (err) {
        console.error("Error in createCycle:", err.message);
        res.status(500).json({ success: false, message: err.message });
    }
}

// ==================== METRICS (ADMIN SETUP) ====================
export async function getEmployeeMetrics(req, res) {
    try {
        const { employeeId } = req.params;
        const { cycleId } = req.query;

        let query = `
            SELECT m.*, c.financial_year, c.cycle_name,
                   e.full_name AS employee_name, e.employee_code, e.salary_grade,
                   d.name AS department_name, ds.title AS designation_name
            FROM kra_performance_metrics m
            JOIN kra_cycles c ON m.cycle_id = c.id
            JOIN employees e ON m.employee_id = e.id
            LEFT JOIN departments d ON e.department_id = d.id
            LEFT JOIN designations ds ON e.designation_id = ds.id
            WHERE m.employee_id = $1
        `;
        const params = [employeeId];

        if (cycleId) {
            query += ` AND m.cycle_id = $2`;
            params.push(cycleId);
        } else {
            query += ` AND c.status = 'active'`;
        }
        query += ` ORDER BY m.id ASC;`;

        const result = await pool.query(query, params);
        
        // Calculate total weightage
        const totalWeightage = result.rows.reduce((sum, r) => sum + parseFloat(r.weightage || 0), 0);

        res.status(200).json({ 
            success: true, 
            data: result.rows,
            totalWeightage: parseFloat(totalWeightage.toFixed(2)),
            isComplete100Percent: Math.abs(totalWeightage - 100) < 0.01
        });
    } catch (err) {
        console.error("Error in getEmployeeMetrics:", err.message);
        res.status(500).json({ success: false, message: err.message });
    }
}

export async function createMetric(req, res) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const {
            cycleId, employeeId, category, categoryDisplay,
            measureName, objective, targetValue, targetUnit,
            targetDisplay, weightage, thresholdMatrix
        } = req.body;

        if (!cycleId || !employeeId || !measureName || !weightage || !thresholdMatrix) {
            return res.status(400).json({ success: false, message: "Missing required fields" });
        }

        // Check current total weightage
        const currWtRes = await client.query(`
            SELECT COALESCE(SUM(weightage), 0) AS total_wt 
            FROM kra_performance_metrics 
            WHERE employee_id = $1 AND cycle_id = $2;
        `, [employeeId, cycleId]);
        
        const currentTotal = parseFloat(currWtRes.rows[0].total_wt);
        const newWeightage = parseFloat(weightage);
        if (currentTotal + newWeightage > 100.01) {
            return res.status(400).json({ 
                success: false, 
                message: `Total weightage cannot exceed 100%. Current: ${currentTotal}%, Attempting to add: ${newWeightage}% (Sum: ${currentTotal + newWeightage}%)` 
            });
        }

        const insertRes = await client.query(`
            INSERT INTO kra_performance_metrics (
                cycle_id, employee_id, category, category_display,
                measure_name, objective, target_value, target_unit,
                target_display, weightage, threshold_matrix
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            RETURNING *;
        `, [
            cycleId, employeeId, category || 'OPERATIONS', categoryDisplay || category || 'Operations & Quality',
            measureName, objective || '', parseFloat(targetValue) || 0, targetUnit || '%',
            targetDisplay || `${targetValue}${targetUnit || '%'}`, newWeightage, thresholdMatrix
        ]);

        const newMetric = insertRes.rows[0];

        // Also ensure an employee assessment row exists in draft
        await client.query(`
            INSERT INTO kra_employee_assessments (cycle_id, metric_id, employee_id, status)
            VALUES ($1, $2, $3, 'draft')
            ON CONFLICT DO NOTHING;
        `, [cycleId, newMetric.id, employeeId]);

        await client.query('COMMIT');
        res.status(201).json({ success: true, data: newMetric, message: "Metric created and assigned successfully" });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Error in createMetric:", err.message);
        res.status(500).json({ success: false, message: err.message });
    } finally {
        client.release();
    }
}

export async function deleteMetric(req, res) {
    try {
        const { id } = req.params;
        await pool.query('DELETE FROM kra_performance_metrics WHERE id = $1', [id]);
        res.status(200).json({ success: true, message: "Metric deleted successfully" });
    } catch (err) {
        console.error("Error in deleteMetric:", err.message);
        res.status(500).json({ success: false, message: err.message });
    }
}

// ==================== ASSESSMENTS (4-LEVEL WORKFLOW) ====================
export async function getEmployeeAssessmentOverview(req, res) {
    try {
        const { employeeId } = req.params;
        const { cycleId } = req.query;

        // Fetch metrics + assessment + proofs
        let query = `
            SELECT m.id AS metric_id, m.category, m.category_display, m.measure_name, m.objective,
                   m.target_value, m.target_unit, m.target_display, m.weightage, m.threshold_matrix,
                   a.id AS assessment_id, a.actual_achieved, a.actual_unit, a.suggested_score,
                   a.self_rating, a.self_reasoning, a.self_submitted_at,
                   a.l1_manager_id, a.l1_rating, a.l1_remarks, a.l1_reviewed_at,
                   a.l2_plant_head_id, a.l2_rating, a.l2_remarks, a.l2_reviewed_at,
                   a.hr_admin_id, a.hr_rating, a.hr_remarks, a.hr_reviewed_at,
                   a.final_weighted_score, a.mars_increment_slab, a.revised_ctc,
                   COALESCE(a.status, 'draft') AS status,
                   m1.full_name AS l1_manager_name,
                   m2.full_name AS l2_plant_head_name,
                   e.full_name AS employee_name, e.employee_code, e.salary_grade,
                   d.name AS department_name, ds.title AS designation_name,
                   c.financial_year, c.cycle_name
            FROM kra_performance_metrics m
            JOIN kra_cycles c ON m.cycle_id = c.id
            JOIN employees e ON m.employee_id = e.id
            LEFT JOIN departments d ON e.department_id = d.id
            LEFT JOIN designations ds ON e.designation_id = ds.id
            LEFT JOIN kra_employee_assessments a ON a.metric_id = m.id AND a.employee_id = m.employee_id
            LEFT JOIN employees m1 ON a.l1_manager_id = m1.id
            LEFT JOIN employees m2 ON a.l2_plant_head_id = m2.id
            WHERE m.employee_id = $1
        `;
        const params = [employeeId];
        if (cycleId) {
            query += ` AND m.cycle_id = $2`;
            params.push(cycleId);
        } else {
            query += ` AND c.status = 'active'`;
        }
        query += ` ORDER BY m.id ASC;`;

        const result = await pool.query(query, params);
        
        // Fetch proof attachments for all assessments of this employee
        const assessmentIds = result.rows.map(r => r.assessment_id).filter(Boolean);
        let proofsMap = {};
        if (assessmentIds.length > 0) {
            const proofsRes = await pool.query(`
                SELECT * FROM kra_proof_attachments 
                WHERE assessment_id = ANY($1::int[]) 
                ORDER BY id ASC;
            `, [assessmentIds]);
            proofsRes.rows.forEach(p => {
                if (!proofsMap[p.assessment_id]) proofsMap[p.assessment_id] = [];
                proofsMap[p.assessment_id].push(p);
            });
        }

        // Attach proofs & compute totals
        let totalWeightage = 0;
        let employeeWeightedSum = 0;
        let l1WeightedSum = 0;
        let l2WeightedSum = 0;
        let hrWeightedSum = 0;
        let overallStatus = 'draft';

        const rowsWithProofs = result.rows.map(row => {
            const proofs = proofsMap[row.assessment_id] || [];
            const wt = parseFloat(row.weightage || 0);
            totalWeightage += wt;

            if (row.self_rating !== null) employeeWeightedSum += (parseFloat(row.self_rating) * wt) / 100;
            if (row.l1_rating !== null) l1WeightedSum += (parseFloat(row.l1_rating) * wt) / 100;
            if (row.l2_rating !== null) l2WeightedSum += (parseFloat(row.l2_rating) * wt) / 100;
            if (row.hr_rating !== null) hrWeightedSum += (parseFloat(row.hr_rating) * wt) / 100;

            if (row.status !== 'draft') overallStatus = row.status;

            return {
                ...row,
                proofs
            };
        });

        // Determine final score: HR score if available, else L2 score, else L1 score, else Emp score
        const activeFinalScore = hrWeightedSum > 0 ? hrWeightedSum : (l2WeightedSum > 0 ? l2WeightedSum : (l1WeightedSum > 0 ? l1WeightedSum : employeeWeightedSum));
        const marsAnalysis = calculateMarsSlab(activeFinalScore);

        res.status(200).json({
            success: true,
            data: rowsWithProofs,
            summary: {
                totalWeightage: parseFloat(totalWeightage.toFixed(2)),
                employeeWeightedScore: parseFloat(employeeWeightedSum.toFixed(2)),
                l1ManagerWeightedScore: parseFloat(l1WeightedSum.toFixed(2)),
                l2PlantHeadWeightedScore: parseFloat(l2WeightedSum.toFixed(2)),
                hrFinalWeightedScore: parseFloat(hrWeightedSum.toFixed(2)),
                activeFinalScore: parseFloat(activeFinalScore.toFixed(2)),
                marsAnalysis,
                overallStatus
            }
        });
    } catch (err) {
        console.error("Error in getEmployeeAssessmentOverview:", err.message);
        res.status(500).json({ success: false, message: err.message });
    }
}

// 1️⃣ LEVEL 1: Employee Submit Self-Assessment
export async function submitEmployeeAssessment(req, res) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { employeeId, cycleId, assessments } = req.body;
        // assessments: [ { metricId, actualAchieved, selfRating, selfReasoning } ]
        if (!employeeId || !assessments || !Array.isArray(assessments)) {
            return res.status(400).json({ success: false, message: "Invalid payload" });
        }

        for (const item of assessments) {
            // Fetch threshold matrix to calculate suggested score
            const metricRes = await client.query('SELECT threshold_matrix FROM kra_performance_metrics WHERE id = $1', [item.metricId]);
            let suggestedScore = null;
            if (metricRes.rows.length > 0) {
                const calc = calculateSuggestedScore(item.actualAchieved, metricRes.rows[0].threshold_matrix);
                suggestedScore = calc.suggestedScore;
            }

            // Upsert into kra_employee_assessments
            const upsertRes = await client.query(`
                INSERT INTO kra_employee_assessments (
                    cycle_id, metric_id, employee_id, actual_achieved,
                    suggested_score, self_rating, self_reasoning,
                    self_submitted_at, status
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), 'submitted_to_l1')
                ON CONFLICT (id) DO UPDATE SET
                    actual_achieved = EXCLUDED.actual_achieved,
                    suggested_score = EXCLUDED.suggested_score,
                    self_rating = EXCLUDED.self_rating,
                    self_reasoning = EXCLUDED.self_reasoning,
                    self_submitted_at = NOW(),
                    status = 'submitted_to_l1',
                    updated_at = NOW()
                RETURNING id;
            `, [cycleId || 1, item.metricId, employeeId, parseFloat(item.actualAchieved) || 0, suggestedScore, parseInt(item.selfRating) || 0, item.selfReasoning || '']);

            const assessmentId = upsertRes.rows[0].id;

            // Audit log
            await client.query(`
                INSERT INTO kra_workflow_audit_logs (
                    assessment_id, cycle_id, actor_id, actor_role, action_type, previous_status, new_status, remarks
                ) VALUES ($1, $2, $3, 'EMPLOYEE', 'SUBMIT_SELF_ASSESSMENT', 'draft', 'submitted_to_l1', $4);
            `, [assessmentId, cycleId || 1, employeeId, item.selfReasoning || 'Self assessment submitted']);
        }

        await client.query('COMMIT');
        res.status(200).json({ success: true, message: "Level 1: Self-Assessment submitted successfully to L1 Manager!" });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Error in submitEmployeeAssessment:", err.message);
        res.status(500).json({ success: false, message: err.message });
    } finally {
        client.release();
    }
}

// 2️⃣ LEVEL 2: L1 Manager Review & Rating
export async function submitL1ManagerReview(req, res) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { managerId, employeeId, cycleId, reviews } = req.body;
        // reviews: [ { assessmentId, l1Rating, l1Remarks } ]
        if (!managerId || !reviews || !Array.isArray(reviews)) {
            return res.status(400).json({ success: false, message: "Invalid payload" });
        }

        for (const item of reviews) {
            await client.query(`
                UPDATE kra_employee_assessments SET
                    l1_manager_id = $1,
                    l1_rating = $2,
                    l1_remarks = $3,
                    l1_reviewed_at = NOW(),
                    status = 'reviewed_l1',
                    updated_at = NOW()
                WHERE id = $4;
            `, [managerId, parseInt(item.l1Rating) || 0, item.l1Remarks || '', item.assessmentId]);

            // Audit log
            await client.query(`
                INSERT INTO kra_workflow_audit_logs (
                    assessment_id, cycle_id, actor_id, actor_role, action_type, previous_status, new_status, remarks
                ) VALUES ($1, $2, $3, 'L1_MANAGER', 'APPROVE_L1', 'submitted_to_l1', 'reviewed_l1', $4);
            `, [item.assessmentId, cycleId || 1, managerId, item.l1Remarks || 'L1 Review Approved']);
        }

        await client.query('COMMIT');
        res.status(200).json({ success: true, message: "Level 2: Manager Review submitted successfully to L2 Plant Head!" });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Error in submitL1ManagerReview:", err.message);
        res.status(500).json({ success: false, message: err.message });
    } finally {
        client.release();
    }
}

// 3️⃣ LEVEL 3: L2 Plant Head Validation
export async function submitL2PlantHeadValidation(req, res) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { plantHeadId, employeeId, cycleId, reviews } = req.body;
        // reviews: [ { assessmentId, l2Rating, l2Remarks } ]
        if (!plantHeadId || !reviews || !Array.isArray(reviews)) {
            return res.status(400).json({ success: false, message: "Invalid payload" });
        }

        for (const item of reviews) {
            await client.query(`
                UPDATE kra_employee_assessments SET
                    l2_plant_head_id = $1,
                    l2_rating = $2,
                    l2_remarks = $3,
                    l2_reviewed_at = NOW(),
                    status = 'validated_l2',
                    updated_at = NOW()
                WHERE id = $4;
            `, [plantHeadId, parseInt(item.l2Rating) || 0, item.l2Remarks || '', item.assessmentId]);

            // Audit log
            await client.query(`
                INSERT INTO kra_workflow_audit_logs (
                    assessment_id, cycle_id, actor_id, actor_role, action_type, previous_status, new_status, remarks
                ) VALUES ($1, $2, $3, 'L2_PLANT_HEAD', 'APPROVE_L2', 'reviewed_l1', 'validated_l2', $4);
            `, [item.assessmentId, cycleId || 1, plantHeadId, item.l2Remarks || 'Plant Head Validation Signed Off']);
        }

        await client.query('COMMIT');
        res.status(200).json({ success: true, message: "Level 3: Plant Head Validation signed off successfully to HR!" });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Error in submitL2PlantHeadValidation:", err.message);
        res.status(500).json({ success: false, message: err.message });
    } finally {
        client.release();
    }
}

// 4️⃣ LEVEL 4: HR Final Moderation, Scoring & Increment Decision
export async function submitHRFinalization(req, res) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { hrAdminId, employeeId, cycleId, reviews, revisedCtc } = req.body;
        // reviews: [ { assessmentId, hrRating, hrRemarks } ]
        if (!hrAdminId || !reviews || !Array.isArray(reviews)) {
            return res.status(400).json({ success: false, message: "Invalid payload" });
        }

        // Calculate final weighted score
        let totalWeightedScore = 0;
        for (const item of reviews) {
            // Get weightage
            const wtRes = await client.query(`
                SELECT m.weightage 
                FROM kra_employee_assessments a
                JOIN kra_performance_metrics m ON a.metric_id = m.id
                WHERE a.id = $1;
            `, [item.assessmentId]);
            const wt = wtRes.rows.length > 0 ? parseFloat(wtRes.rows[0].weightage) : 0;
            const hrRating = parseInt(item.hrRating) || 0;
            totalWeightedScore += (hrRating * wt) / 100;
        }

        const marsResult = calculateMarsSlab(totalWeightedScore);

        for (const item of reviews) {
            await client.query(`
                UPDATE kra_employee_assessments SET
                    hr_admin_id = $1,
                    hr_rating = $2,
                    hr_remarks = $3,
                    hr_reviewed_at = NOW(),
                    final_weighted_score = $4,
                    mars_increment_slab = $5,
                    revised_ctc = $6,
                    status = 'hr_finalized',
                    updated_at = NOW()
                WHERE id = $7;
            `, [
                hrAdminId, parseInt(item.hrRating) || 0, item.hrRemarks || '',
                parseFloat(totalWeightedScore.toFixed(2)), marsResult.slab,
                parseFloat(revisedCtc) || null, item.assessmentId
            ]);

            // Audit log
            await client.query(`
                INSERT INTO kra_workflow_audit_logs (
                    assessment_id, cycle_id, actor_id, actor_role, action_type, previous_status, new_status, remarks
                ) VALUES ($1, $2, $3, 'HR_ADMIN', 'FINALIZE_HR', 'validated_l2', 'hr_finalized', $4);
            `, [item.assessmentId, cycleId || 1, hrAdminId, `Final score: ${totalWeightedScore.toFixed(2)} (${marsResult.slab} Variable Pay)`]);
        }

        await client.query('COMMIT');
        res.status(200).json({
            success: true,
            data: {
                finalWeightedScore: parseFloat(totalWeightedScore.toFixed(2)),
                marsAnalysis: marsResult,
                revisedCtc: parseFloat(revisedCtc) || null
            },
            message: "Level 4: HR Final Appraisal & Increment Matrix finalized successfully!"
        });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Error in submitHRFinalization:", err.message);
        res.status(500).json({ success: false, message: err.message });
    } finally {
        client.release();
    }
}

// ==================== PROOF ATTACHMENTS ====================
export async function uploadProofAttachment(req, res) {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: "No file uploaded" });
        }
        const { assessmentId, employeeId } = req.body;
        if (!assessmentId) {
            return res.status(400).json({ success: false, message: "assessmentId is required" });
        }

        const fileName = req.file.originalname;
        const filePath = `/uploads/kra_proofs/${req.file.filename}`;
        const fileSizeKb = Math.round(req.file.size / 1024);
        const fileType = path.extname(fileName).replace('.', '').toLowerCase();

        const insertRes = await pool.query(`
            INSERT INTO kra_proof_attachments (
                assessment_id, employee_id, file_name, file_path, file_type, file_size_kb
            ) VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING *;
        `, [assessmentId, employeeId || 1, fileName, filePath, fileType, fileSizeKb]);

        res.status(201).json({
            success: true,
            data: insertRes.rows[0],
            message: "Proof document attached successfully"
        });
    } catch (err) {
        console.error("Error in uploadProofAttachment:", err.message);
        res.status(500).json({ success: false, message: err.message });
    }
}

export async function deleteProofAttachment(req, res) {
    try {
        const { id } = req.params;
        const result = await pool.query('DELETE FROM kra_proof_attachments WHERE id = $1 RETURNING *', [id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: "Proof not found" });
        }
        res.status(200).json({ success: true, message: "Proof attachment removed successfully" });
    } catch (err) {
        console.error("Error in deleteProofAttachment:", err.message);
        res.status(500).json({ success: false, message: err.message });
    }
}
