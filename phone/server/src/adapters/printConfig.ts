import { loadConfig, safeConfigForLog } from "../config.js";

const config = loadConfig();
console.log(JSON.stringify(safeConfigForLog(config), null, 2));
