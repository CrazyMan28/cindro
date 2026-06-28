import { loadConfig, safeConfigForLog } from "./config.js";
import { createApp } from "./app.js";
import { serverUrls } from "./setup/status.js";

const config = loadConfig();
const { app } = await createApp(config);

try {
  app.log.info(safeConfigForLog(config), "loaded safe agent phone config");
  await app.listen({ host: config.server.host, port: config.server.port });
  const urls = serverUrls(config.server.port);
  app.log.info(
    {
      host: config.server.host,
      port: config.server.port,
      localUrl: urls.localUrl,
      lanUrls: urls.lanUrls,
      tailscaleUrls: urls.tailscaleUrls,
      androidUrl: urls.tailscaleUrls[0] ?? urls.lanUrls[0] ?? urls.localUrl,
      bindUrl: `http://${config.server.host}:${config.server.port}`
    },
    "agent phone server listening"
  );
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
