import { Router, type IRouter } from "express";
import healthRouter from "./health";
import airQualityRouter from "./air-quality";

const router: IRouter = Router();

router.use(healthRouter);
router.use(airQualityRouter);

export default router;
