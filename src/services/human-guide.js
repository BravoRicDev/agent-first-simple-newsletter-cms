import { readFileSync } from "fs";

const GUIDE_URL = new URL("../../content/human-guide.md", import.meta.url);

export function buildHumanGuide() {
  return readFileSync(GUIDE_URL, "utf-8");
}

export default buildHumanGuide;
