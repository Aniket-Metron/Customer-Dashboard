import { Router } from 'express';
import { getHomeIntegrations } from '../controllers/homeController';
import { getAppIntegrations } from '../controllers/appsController';

const router = Router();

router.get('/home/integrations', getHomeIntegrations);
router.get('/apps/integrations', getAppIntegrations);

export default router;
