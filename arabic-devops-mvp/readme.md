# Arabic DevOps Agent MVP

هذه الحزمة تضيف Runtime حقيقيًا خلف واجهة `arabic-devops-agent.html`.

## ما تم تنفيذه

- `server.mjs`: خادم Node.js بدون اعتماديات خارجية.
- `POST /api/plan`: يحول الطلب العربي إلى خطة وحالة وخطورة.
- `POST /api/approvals/:id`: بوابة موافقة ثم تحقق فعلي من PR وCI وحماية الفرع ودمج Squash عبر GitHub API.
- `GET /api/github/repos` وقراءة Pull Request.
- `POST /api/tools/execute`: Registry محدود لأوامر Git وGitHub CLI للقراءة فقط.
- `execution-ledger.jsonl`: سجل تدقيق append-only لكل خطة وموافقة وفحص وتنفيذ وفشل.
- `smoke-test.mjs`: اختبار Runtime كامل باستخدام Mock GitHub محلي، بدون استخدام Token حقيقي.
- `real-github-e2e.mjs`: اختبار التكامل الحقيقي؛ يتطلب بيئة GitHub مخصصة وToken محليًا، ويرفض الدمج دون `--execute` و`E2E_CONFIRM_MERGE=YES`.
- كل موافقة لها `approvalId` أحادي الاستخدام؛ لا يمكن إعادة تشغيل خطة بعد `RUNNING` أو `COMPLETED` أو `BLOCKED`.
- السجل يربط `planId` و`approvalId` و`actor` و`intent` و`repository` و`pullRequest` و`requestedAction` ونتائج فحص CI وحماية الفرع.
- `GITHUB_ALLOWED_REPOSITORIES` يفرض allowlist صريحة، و`WORKSPACE_ROOT` يحصر CLI داخل مسار حقيقي واحد مع حماية symlink/path traversal.
- مخرجات CLI محدودة إلى 64 KiB، والمهلة 30 ثانية، ومعدل API محدود محليًا.
- الواجهة الحالية تبقى قابلة للفتح منفردة كنموذج Demo، ويخدمها الخادم عند تشغيله.

## التشغيل

يتطلب Node.js 20 أو أحدث. من داخل هذا المجلد:

```bash
cp .env.example .env
export GITHUB_TOKEN="توكن GitHub بصلاحيات محدودة"
export GITHUB_REPOSITORY="owner/repository"
export GITHUB_ALLOWED_REPOSITORIES="owner/repository"
export WORKSPACE_ROOT="/path/to/repository"
npm start
```

ثم افتح `http://localhost:8787`.

للتحقق من Runtime قبل ربط GitHub حقيقي:

```bash
npm test
```

يستخدم الاختبار `GITHUB_API_BASE` داخليًا لتوجيه Provider إلى Mock محلي.

لاختبار GitHub الحقيقي، شغّل Runtime أولًا، وجهّز PRs المخصصة للحالات الإيجابية والسلبية، ثم اضبط المتغيرات الموجودة في `.env.real-e2e.example` محليًا وشغّل:

```bash
E2E_CONFIRM_MERGE=YES npm run test:real
```

السكربت لا ينشئ مستودعًا أو يغيّر Branch Protection تلقائيًا، ولا يطبع أو يحفظ `GITHUB_TOKEN`. ينفذ الدمج فقط عند التأكيد الصريح، ويحفظ `summary.json` و`ledger.json` داخل `evidence/real-github-e2e/<timestamp>/`.

## حدود MVP الأمنية

- لا يوجد تنفيذ Shell حر؛ الأدوات تمر عبر `CLI_REGISTRY` وبـ`shell: false`.
- أدوات الكتابة غير مضافة إلى Registry افتراضيًا.
- الدمج لا يحدث إلا من خلال Approval Gate أحادي الاستخدام، وبعد نجاح كل فحوصات CI وثبوت أن الفرع محمي.
- لا تحفظ الأسرار في الواجهة أو السجل.
- لا تقبل واجهة CLI حججًا حرة من الطلب؛ الأداة والحجج ثابتة في Registry.
- يُنصح باستخدام GitHub App في الإنتاج بدل Personal Access Token.
- يحتاج النظام لاحقًا إلى تخزين دائم للخطط، هوية المستخدم، OAuth، CSRF protection، rate limiting، وbranch-policy أدق.
