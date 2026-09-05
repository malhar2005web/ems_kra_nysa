import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import {
    getCycles, createCycle,
    getEmployeeMetrics, createMetric, deleteMetric,
    getEmployeeAssessmentOverview,
    submitEmployeeAssessment,
    submitL1ManagerReview,
    submitL2PlantHeadValidation,
    submitHRFinalization,
    uploadProofAttachment, deleteProofAttachment,
    calculateSuggestedScore
} from '../controller/kra.controller.js';

const router = express.Router();

// Setup Multer Storage for KRA Proofs
const uploadDir = path.join(process.cwd(), 'uploads', 'kra_proofs');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname);
        cb(null, 'kra-proof-' + uniqueSuffix + ext);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 25 * 1024 * 1024 }, // 25MB limit
    fileFilter: (req, file, cb) => {
        const allowedExts = ['.pdf', '.xlsx', '.xls', '.docx', '.doc', '.csv', '.png', '.jpg', '.jpeg', '.webp'];
        const ext = path.extname(file.originalname).toLowerCase();
        if (allowedExts.includes(ext)) {
            cb(null, true);
        } else {
            cb(new Error('Invalid file format. Allowed formats: PDF, Excel, Word, CSV, Images'));
        }
    }
});

// Cycles
router.get('/cycles', getCycles);
router.post('/cycles', createCycle);

// Metrics (Admin Setup)
router.get('/metrics/:employeeId', getEmployeeMetrics);
router.post('/metrics', createMetric);
router.delete('/metrics/:id', deleteMetric);

// Assessment Overview (All 4 Levels + Proofs)
router.get('/assessments/:employeeId', getEmployeeAssessmentOverview);

// Score Calculation Helper
router.post('/calculate-score', (req, res) => {
    const { actualValue, thresholdMatrix } = req.body;
    const result = calculateSuggestedScore(actualValue, thresholdMatrix);
    res.status(200).json({ success: true, data: result });
});

// 1️⃣ Level 1: Employee Self-Assessment Submit
router.post('/assessments/employee-submit', submitEmployeeAssessment);

// 2️⃣ Level 2: L1 Manager Review Submit
router.post('/assessments/l1-review', submitL1ManagerReview);

// 3️⃣ Level 3: L2 Plant Head Validation Submit
router.post('/assessments/l2-validate', submitL2PlantHeadValidation);

// 4️⃣ Level 4: HR Finalization & Increment Submit
router.post('/assessments/hr-finalize', submitHRFinalization);

// Proof Attachments
router.post('/proofs/upload', upload.single('proofFile'), uploadProofAttachment);
router.delete('/proofs/:id', deleteProofAttachment);

export default router;
