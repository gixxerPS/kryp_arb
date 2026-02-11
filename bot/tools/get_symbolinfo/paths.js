const path = require("node:path");

// repo root: tools/get_symbolinfo/../.. => bot/
const REPO_ROOT = path.resolve(__dirname, "../..");

const CONFIG_DIR = path.join(REPO_ROOT, "config");
const SYMBOLINFO_DIR = path.join(CONFIG_DIR, "symbolinfo");

const BOT_CFG_PATH = path.join(CONFIG_DIR, "bot.json");
const SYMBOLS_CFG_PATH = path.join(CONFIG_DIR, "symbols.json");

module.exports = {
    REPO_ROOT,
    CONFIG_DIR,
    SYMBOLINFO_DIR,
    BOT_CFG_PATH,
    SYMBOLS_CFG_PATH
}