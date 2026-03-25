import { initRouter } from "./router.js";
import { initDashboard } from "./pages/dashboardPage.js";
import { startManipulator } from "./controllers/manipulatorController.js";

initRouter();
initDashboard();
startManipulator();
