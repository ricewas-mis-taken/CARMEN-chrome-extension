// usage (from clone root): node Quinn-11.check.mjs [clone-root]  (~3s)
import { loadSharing } from "./Quinn-shvm.mjs";
const { ctx, calls } = loadSharing(process.argv[2] || ".", { tabs: { 1: { id: 1, windowId: 7, url: "https://youtube.com/" } } });
await ctx.forceCloseTab(1);
if (calls.windowsRemove.length) { console.error("FAIL: whole window closed", calls.windowsRemove.length, "times"); process.exit(1); }
console.log("ok");
