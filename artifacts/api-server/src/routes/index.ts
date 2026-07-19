import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import dashboardRouter from "./dashboard";
import inventoryRouter from "./inventory";
import branchesRouter from "./branches";
import purchasesRouter from "./purchases";
import productionRouter from "./production";
import bomRouter from "./bom";
import stockRouter from "./stock";
import salesRouter from "./sales";
import hrRouter from "./hr";
import customersRouter from "./customers";
import accountsRouter from "./accounts";
import companyRouter from "./company";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(dashboardRouter);
router.use(inventoryRouter);
router.use(branchesRouter);
router.use(purchasesRouter);
router.use(productionRouter);
router.use(bomRouter);
router.use(stockRouter);
router.use(salesRouter);
router.use(hrRouter);
router.use(customersRouter);
router.use(accountsRouter);
router.use(companyRouter);

export default router;
