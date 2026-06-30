// test/config.test.mjs - verify route config keeps optional publish targets like GBP.
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, routeForThread } from "../src/config.mjs";

let pass = 0;
const ok = (n) => { console.log(`ok ${n}`); pass++; };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cfg-"));
const file = path.join(tmp, "routes.json");

fs.writeFileSync(file, JSON.stringify({
  defaults: { debounceMs: 1234, maxWaitMs: 5678, published: false, facebookAutoPublish: false, gbpAutoPublish: false },
  routes: [{
    threadId: "g1",
    label: "Group 1",
    fanpageId: "p1",
    fanpageTokenEnv: "FB_PAGE_TOKEN_TEST",
    gbpLocationId: "9876543210",
    facebookAutoPublish: true,
    gbpAutoPublish: true,
    captionFooter: "footer",
  }],
}, null, 2));

{
  process.env.FB_PAGE_TOKEN_TEST = "page-token";
  const cfg = loadConfig(file);
  const r = routeForThread(cfg, "g1");
  assert.equal(r.gbpLocationId, "9876543210");
  assert.equal(r.fanpageToken, "page-token");
  assert.equal(r.debounceMs, 1234);
  assert.equal(r.maxWaitMs, 5678);
  assert.equal(r.facebookAutoPublish, true);
  assert.equal(r.gbpAutoPublish, true);
  ok("loadConfig preserves gbpLocationId and defaults");
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`PASS ${pass}/${pass} test.`);
