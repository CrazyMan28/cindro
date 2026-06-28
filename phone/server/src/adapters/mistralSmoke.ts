import { loadConfig, safeConfigForLog } from "../config.js";
import { runRealMistralSmokeTest, validateMistralConfig } from "../mistral/index.js";

const mode = process.argv.includes("--validate-only") ? "validate" : "smoke";
const config = loadConfig({ MISTRAL_REAL_AUDIO: process.env.MISTRAL_REAL_AUDIO ?? "true" });

try {
  if (mode === "validate") {
    const result = await validateMistralConfig(config.mistral, { verifyModels: process.argv.includes("--models") });
    console.log(JSON.stringify({ config: safeConfigForLog(config), result }, null, 2));
  } else {
    const result = await runRealMistralSmokeTest(config.mistral, process.env.MISTRAL_TEST_OUTPUT_DIR ?? "tmp");
    console.log(JSON.stringify(result, null, 2));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Mistral smoke test failed");
  process.exit(1);
}
