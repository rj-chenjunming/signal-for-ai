const fs = require("fs");
const path = require("path");
const f = path.join(__dirname, "tail-test.log");
fs.writeFileSync(f, "line1\nline2\nline3\n");
const st = fs.statSync(f);
console.log("  文件大小:", st.size, "bytes");
// 模拟首次 tail 读取(从末尾 N 字节)
const fd = fs.openSync(f, "r");
const from = Math.max(0, st.size - 16);
const buf = Buffer.alloc(st.size - from);
fs.readSync(fd, buf, 0, buf.length, from);
console.log("  tail 16 字节 =>", JSON.stringify(buf.toString("utf8")));
fs.closeSync(fd);
// 模拟增量: 追加后只读新增部分
fs.appendFileSync(f, "line4\nline5\n");
const st2 = fs.statSync(f);
const buf2 = Buffer.alloc(st2.size - st.size);
const fd2 = fs.openSync(f, "r");
fs.readSync(fd2, buf2, 0, buf2.length, st.size);
console.log("  增量读取 =>", JSON.stringify(buf2.toString("utf8")));
fs.closeSync(fd2);
console.log("  [OK] Node fs 增量 tail 可行, 无需第三方库");
// 目录 glob 能力
const dir = __dirname;
const hits = fs.readdirSync(dir).filter(f => f.endsWith(".log"));
console.log("  readdirSync *.log命中:", JSON.stringify(hits));
console.log("  [OK] readdirSync 可做单层 glob; 递归 glob 需自己实现或用 tinyglobby");