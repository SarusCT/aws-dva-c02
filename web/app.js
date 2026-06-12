/* Giáo trình AWS DVA-C02 — viewer */

const PARTS = [
  { name: "Phần I — Nền tảng AWS", from: 1, to: 11 },
  { name: "Phần II — Storage & Content Delivery", from: 12, to: 15 },
  { name: "Phần III — Containers & Platform Deployment", from: 16, to: 20 },
  { name: "Phần IV — Messaging & Integration", from: 21, to: 23 },
  { name: "Phần V — Monitoring & Audit", from: 24, to: 27 },
  { name: "Phần VI — Serverless Core", from: 28, to: 35 },
  { name: "Phần VII — Serverless Tooling & Identity", from: 36, to: 39 },
  { name: "Phần VIII — CI/CD trên AWS", from: 40, to: 42 },
  { name: "Phần IX — Advanced Serverless & Security", from: 43, to: 48 },
  { name: "Phần X — Luyện thi", from: 49, to: 50 },
];

const CHAPTERS = [
  { num: 1,  slug: "tong-quan-aws-dva-c02", title: "Tổng quan AWS & Kỳ thi DVA-C02" },
  { num: 2,  slug: "iam", title: "IAM — Identity and Access Management" },
  { num: 3,  slug: "aws-cli-sdk", title: "AWS CLI & SDK" },
  { num: 4,  slug: "ec2-fundamentals", title: "EC2 Fundamentals" },
  { num: 5,  slug: "ec2-instance-storage", title: "EC2 Instance Storage — EBS, EFS, Instance Store" },
  { num: 6,  slug: "elb", title: "Elastic Load Balancing (ELB)" },
  { num: 7,  slug: "asg", title: "Auto Scaling Groups (ASG)" },
  { num: 8,  slug: "rds-aurora", title: "RDS & Aurora" },
  { num: 9,  slug: "elasticache", title: "ElastiCache — Redis & Memcached" },
  { num: 10, slug: "route-53", title: "Route 53" },
  { num: 11, slug: "vpc", title: "VPC cho Developer" },
  { num: 12, slug: "s3-co-ban", title: "Amazon S3 cơ bản" },
  { num: 13, slug: "advanced-s3", title: "Advanced S3" },
  { num: 14, slug: "s3-security", title: "Amazon S3 Security" },
  { num: 15, slug: "cloudfront", title: "CloudFront" },
  { num: 16, slug: "docker-ecr", title: "Docker trên AWS & Amazon ECR" },
  { num: 17, slug: "ecs-fargate", title: "ECS & Fargate" },
  { num: 18, slug: "elastic-beanstalk", title: "AWS Elastic Beanstalk" },
  { num: 19, slug: "cloudformation-co-ban", title: "AWS CloudFormation cơ bản" },
  { num: 20, slug: "cloudformation-nang-cao", title: "AWS CloudFormation nâng cao" },
  { num: 21, slug: "sqs", title: "Amazon SQS" },
  { num: 22, slug: "sns", title: "Amazon SNS" },
  { num: 23, slug: "kinesis", title: "Amazon Kinesis" },
  { num: 24, slug: "cloudwatch-metrics-alarms", title: "CloudWatch Metrics & Alarms" },
  { num: 25, slug: "cloudwatch-logs-eventbridge", title: "CloudWatch Logs & EventBridge" },
  { num: 26, slug: "x-ray", title: "AWS X-Ray" },
  { num: 27, slug: "cloudtrail", title: "AWS CloudTrail & Audit" },
  { num: 28, slug: "lambda-co-ban", title: "AWS Lambda cơ bản" },
  { num: 29, slug: "lambda-nang-cao", title: "AWS Lambda nâng cao" },
  { num: 30, slug: "lambda-integrations", title: "Lambda Integrations & Event Source Mappings" },
  { num: 31, slug: "dynamodb-co-ban", title: "Amazon DynamoDB cơ bản" },
  { num: 32, slug: "dynamodb-nang-cao", title: "Amazon DynamoDB nâng cao" },
  { num: 33, slug: "dynamodb-dax-streams", title: "DynamoDB DAX, Streams, TTL & Global Tables" },
  { num: 34, slug: "api-gateway-co-ban", title: "Amazon API Gateway cơ bản" },
  { num: 35, slug: "api-gateway-nang-cao", title: "Amazon API Gateway nâng cao" },
  { num: 36, slug: "sam", title: "AWS SAM — Serverless Application Model" },
  { num: 37, slug: "cdk", title: "AWS CDK — Cloud Development Kit" },
  { num: 38, slug: "cognito-user-pools", title: "Amazon Cognito User Pools" },
  { num: 39, slug: "cognito-identity-pools", title: "Cognito Identity Pools & Cognito Sync" },
  { num: 40, slug: "codecommit-codebuild", title: "CodeCommit & CodeBuild" },
  { num: 41, slug: "codedeploy", title: "CodeDeploy" },
  { num: 42, slug: "codepipeline", title: "CodePipeline & các công cụ CI/CD khác" },
  { num: 43, slug: "step-functions", title: "AWS Step Functions" },
  { num: 44, slug: "appsync-amplify", title: "AWS AppSync & Amplify" },
  { num: 45, slug: "advanced-identity-sts", title: "Advanced Identity — STS, Federation & IAM nâng cao" },
  { num: 46, slug: "kms-encryption", title: "AWS KMS & Encryption" },
  { num: 47, slug: "parameter-store-secrets-manager", title: "SSM Parameter Store & Secrets Manager" },
  { num: 48, slug: "other-services", title: "Các dịch vụ khác trong phạm vi DVA-C02" },
  { num: 49, slug: "de-thi-mo-phong", title: "Bộ đề luyện thi mô phỏng DVA-C02 (65 câu)" },
  { num: 50, slug: "tips-lam-bai", title: "Tips làm bài & chiến lược ôn tập" },
];

const pad = n => String(n).padStart(2, "0");
const $ = sel => document.querySelector(sel);
const store = {
  get done() { try { return new Set(JSON.parse(localStorage.getItem("dva.done") || "[]")); } catch { return new Set(); } },
  set done(s) { localStorage.setItem("dva.done", JSON.stringify([...s])); },
};

/* ---------- theme ---------- */
const themeInit = localStorage.getItem("dva.theme")
  || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
document.documentElement.dataset.theme = themeInit;
$("#themeBtn").onclick = () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  localStorage.setItem("dva.theme", next);
};

/* ---------- sidebar ---------- */
function renderToc() {
  const done = store.done;
  const toc = $("#toc");
  toc.innerHTML = PARTS.map(part => {
    const items = CHAPTERS.filter(c => c.num >= part.from && c.num <= part.to)
      .map(c => `<a href="#ch${pad(c.num)}" data-num="${c.num}" data-text="${(c.num + " " + c.title).toLowerCase()}">
          <span class="n">${pad(c.num)}</span><span>${c.title}</span>
          ${done.has(c.num) ? '<span class="done-dot">●</span>' : ""}
        </a>`).join("");
    return `<div class="toc-part">${part.name}</div>${items}`;
  }).join("");
  $("#doneCount").textContent = `${done.size}/50 ✓`;
}

$("#searchBox").addEventListener("input", e => {
  const q = e.target.value.trim().toLowerCase();
  document.querySelectorAll("#toc a").forEach(a => {
    a.classList.toggle("hidden", q && !a.dataset.text.includes(q));
  });
});

$("#menuBtn").onclick = () => document.body.classList.add("nav-open");
$("#scrim").onclick = () => document.body.classList.remove("nav-open");
$("#toc").addEventListener("click", () => document.body.classList.remove("nav-open"));
$("#printBtn").onclick = () => print();

/* ---------- tải & render chương ---------- */
async function fetchChapter(ch) {
  const base = `../chapters/ch${pad(ch.num)}-${ch.slug}`;
  // Ưu tiên file đã ghép; nếu chưa có thì ghép part1 + part2 ngay trên client
  let res = await fetch(`${base}.md`);
  if (res.ok) return res.text();
  const [p1, p2] = await Promise.all([fetch(`${base}.part1.md`), fetch(`${base}.part2.md`)]);
  if (!p1.ok && !p2.ok) throw new Error("missing");
  return (p1.ok ? await p1.text() : "") + "\n\n" + (p2.ok ? await p2.text() : "");
}

function decorate(reader, ch) {
  // exam tip / trọng tâm
  reader.querySelectorAll("blockquote").forEach(bq => {
    const t = bq.textContent;
    if (t.includes("💡")) bq.classList.add("tip");
    else if (t.includes("Trọng tâm")) bq.classList.add("focus");
  });
  // gập phần đáp án quiz vào <details>
  reader.querySelectorAll("h3").forEach(h3 => {
    if (!/^Đáp án/.test(h3.textContent.trim())) return;
    const details = document.createElement("details");
    details.className = "answers";
    const summary = document.createElement("summary");
    summary.textContent = "Xem đáp án & giải thích";
    details.appendChild(summary);
    let node = h3.nextSibling;
    while (node && !(node.nodeType === 1 && /^H[123]$/.test(node.tagName))) {
      const next = node.nextSibling;
      details.appendChild(node);
      node = next;
    }
    h3.replaceWith(details);
  });
  reader.querySelectorAll("pre code").forEach(b => hljs.highlightElement(b));
  // nút đánh dấu đã học
  const btn = document.createElement("button");
  btn.className = "done-btn";
  const sync = () => {
    const isDone = store.done.has(ch.num);
    btn.classList.toggle("is-done", isDone);
    btn.textContent = isDone ? "✓ Đã học xong chương này" : "Đánh dấu đã học xong";
  };
  btn.onclick = () => {
    const s = store.done;
    s.has(ch.num) ? s.delete(ch.num) : s.add(ch.num);
    store.done = s;
    sync(); renderToc(); markActive(ch.num);
  };
  sync();
  reader.appendChild(btn);
}

function renderNav(ch) {
  const i = CHAPTERS.indexOf(ch);
  const prev = CHAPTERS[i - 1], next = CHAPTERS[i + 1];
  $("#chapterNav").innerHTML =
    (prev ? `<a class="prev" href="#ch${pad(prev.num)}"><span class="dir">← Chương trước</span><span class="ttl">${pad(prev.num)}. ${prev.title}</span></a>` : "<span style='flex:1'></span>") +
    (next ? `<a class="next" href="#ch${pad(next.num)}"><span class="dir">Chương sau →</span><span class="ttl">${pad(next.num)}. ${next.title}</span></a>` : "");
}

function markActive(num) {
  document.querySelectorAll("#toc a").forEach(a => {
    a.classList.toggle("active", +a.dataset.num === num);
  });
  const active = document.querySelector("#toc a.active");
  if (active) active.scrollIntoView({ block: "nearest" });
}

async function loadChapter(num) {
  const ch = CHAPTERS.find(c => c.num === num) || CHAPTERS[0];
  const reader = $("#reader");
  $("#crumb").textContent = `Chương ${pad(ch.num)} · ${ch.title}`;
  document.title = `Ch.${pad(ch.num)} ${ch.title} — AWS DVA-C02`;
  markActive(ch.num);
  renderNav(ch);
  reader.innerHTML = `<div class="loading">Đang tải chương ${pad(ch.num)}…</div>`;
  try {
    const md = await fetchChapter(ch);
    reader.innerHTML = marked.parse(md, { mangle: false, headerIds: false });
    decorate(reader, ch);
  } catch {
    reader.innerHTML = `<div class="missing"><span class="big">✍️</span>
      Chương ${pad(ch.num)} — <b>${ch.title}</b> đang được biên soạn.<br>
      Quay lại sau nhé.</div>`;
    $("#chapterNav").innerHTML && renderNav(ch);
  }
  scrollTo({ top: 0 });
}

/* ---------- routing & phím tắt ---------- */
function route() {
  const m = location.hash.match(/^#ch(\d{1,2})$/);
  loadChapter(m ? +m[1] : 1);
}
addEventListener("hashchange", route);

addEventListener("keydown", e => {
  if (e.target.matches("input, textarea")) {
    if (e.key === "Escape") e.target.blur();
    return;
  }
  const cur = +(location.hash.match(/\d+/) || [1])[0];
  if (e.key === "ArrowRight" && cur < 50) location.hash = `#ch${pad(cur + 1)}`;
  if (e.key === "ArrowLeft" && cur > 1) location.hash = `#ch${pad(cur - 1)}`;
  if (e.key === "/") { e.preventDefault(); $("#searchBox").focus(); }
});

addEventListener("scroll", () => {
  const h = document.documentElement;
  const max = h.scrollHeight - h.clientHeight;
  $("#progressBar").style.width = max > 0 ? (h.scrollTop / max) * 100 + "%" : "0";
}, { passive: true });

renderToc();
route();
