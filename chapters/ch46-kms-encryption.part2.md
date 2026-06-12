## Hands-on Lab: Envelope encryption end-to-end với KMS — customer managed key, key policy, GenerateDataKey, grant, rotation và ViaService

**Mục tiêu lab:** Dựng một customer managed KMS key (CMK) hoàn chỉnh và đi xuyên các điểm thi cốt lõi của Chương 46: viết key policy kết hợp với IAM, mã hóa trực tiếp ≤4KB bằng `Encrypt`/`Decrypt`, thực hiện **envelope encryption** thủ công bằng `GenerateDataKey` (mã hóa file lớn ngoài giới hạn 4KB), cấp quyền tạm bằng **grant** thay vì sửa policy, bật **automatic key rotation**, và giới hạn key chỉ dùng được qua một service bằng condition `kms:ViaService`. Lab làm rõ vì sao envelope encryption tồn tại và data key hoạt động ra sao — phần lý thuyết hay bị hiểu mơ hồ.

**Chuẩn bị:**
- AWS CLI v2 (`aws --version` ≥ 2.x), một IAM identity trong tài khoản sandbox có quyền `kms:*` và `sts:GetCallerIdentity`.
- `openssl` (có sẵn trên macOS/Linux) để mã hóa file bằng data key.
- (Tùy chọn) Node.js ≥ 18 cho phần SDK v3: `npm i @aws-sdk/client-kms`.
- Đặt biến môi trường:

```bash
export AWS_REGION=ap-southeast-1
export ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
export ME=$(aws sts get-caller-identity --query Arn --output text)
echo "Account=$ACCOUNT  Caller=$ME"
```

### Bước 1: Tạo customer managed key với key policy tường minh

KMS key **bắt buộc có một key policy**. Nếu không truyền `--policy`, AWS gắn default key policy mở quyền cho `root` của account (cho phép IAM policy quyết định). Ở đây ta viết policy tường minh để thấy rõ cơ chế: root được toàn quyền administer (để IAM hoạt động), còn caller hiện tại được dùng key.

```bash
cat > /tmp/key-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "EnableRootAccountAdmin",
      "Effect": "Allow",
      "Principal": { "AWS": "arn:aws:iam::${ACCOUNT}:root" },
      "Action": "kms:*",
      "Resource": "*"
    },
    {
      "Sid": "AllowCallerUseKey",
      "Effect": "Allow",
      "Principal": { "AWS": "${ME}" },
      "Action": [
        "kms:Encrypt", "kms:Decrypt", "kms:GenerateDataKey*",
        "kms:DescribeKey", "kms:CreateGrant"
      ],
      "Resource": "*"
    }
  ]
}
EOF

export KEY_ID=$(aws kms create-key \
  --description "ch46-envelope-lab" \
  --key-usage ENCRYPT_DECRYPT \
  --key-spec SYMMETRIC_DEFAULT \
  --policy file:///tmp/key-policy.json \
  --query KeyMetadata.KeyId --output text)

# Tạo alias cho dễ tham chiếu (đề thi hay nhắc alias/<name>)
aws kms create-alias --alias-name alias/ch46-lab --target-key-id "$KEY_ID"
echo "KEY_ID=$KEY_ID"
```

**Output mong đợi:** một KeyId dạng UUID. `Resource: "*"` trong key policy nghĩa là "key này" — KMS key policy luôn tự tham chiếu chính nó, không phải mọi key.

> Bẫy thi kinh điển: trong KMS, **IAM policy một mình KHÔNG đủ** — quyền chỉ có hiệu lực khi key policy cho phép (qua statement `root` mở cửa, hoặc qua statement trỏ thẳng principal). Đây là khác biệt lớn so với hầu hết service khác.

### Bước 2: Encrypt/Decrypt trực tiếp — và chạm giới hạn 4KB

`Encrypt` chỉ nhận tối đa **4096 bytes** plaintext cho symmetric key. Đây là lý do ta không dùng nó cho file lớn.

```bash
# Mã hóa một chuỗi ngắn (vd: một password) -> trả ciphertext base64
aws kms encrypt \
  --key-id alias/ch46-lab \
  --plaintext "$(echo -n 'db-password-123' | base64)" \
  --query CiphertextBlob --output text > /tmp/secret.b64

# Giải mã lại
aws kms decrypt \
  --ciphertext-blob fileb://<(base64 --decode /tmp/secret.b64) \
  --query Plaintext --output text | base64 --decode
# Output mong đợi: db-password-123
```

Lưu ý: ta KHÔNG cần truyền `--key-id` khi decrypt với symmetric key — KMS đọc key ID nhúng sẵn trong ciphertext blob. (Với asymmetric key thì phải truyền key-id + encryption algorithm.)

```bash
# Thử mã hóa 5KB -> vượt limit, KMS từ chối
head -c 5000 /dev/urandom | base64 > /tmp/big.b64
aws kms encrypt --key-id alias/ch46-lab \
  --plaintext fileb:///tmp/big.b64 2>&1 | head -2
# Output mong đợi: ... ValidationException ... member must have length <= 4096
```

### Bước 3: Envelope encryption thủ công với GenerateDataKey

Để mã hóa dữ liệu lớn, KMS không tự làm mà cấp cho ta một **data key**: `GenerateDataKey` trả về cả `Plaintext` (data key thô để mã hóa cục bộ) lẫn `CiphertextBlob` (chính data key đó đã được CMK mã hóa). Ta mã hóa file bằng data key plaintext, **xóa data key plaintext khỏi bộ nhớ**, rồi lưu kèm ciphertext của data key. Đây chính là envelope encryption.

```bash
# 1) Xin một data key AES-256
aws kms generate-data-key \
  --key-id alias/ch46-lab \
  --key-spec AES_256 \
  --query '{Plain:Plaintext,Enc:CiphertextBlob}' --output json > /tmp/dk.json

# Tách 2 phần
jq -r .Plain /tmp/dk.json | base64 --decode > /tmp/datakey.bin   # 32 bytes
jq -r .Enc   /tmp/dk.json > /tmp/datakey.enc.b64                 # data key đã mã hóa

# 2) Tạo dữ liệu lớn rồi mã hóa cục bộ bằng data key (KHÔNG gọi KMS)
head -c 1048576 /dev/urandom > /tmp/plain.dat   # 1MB
openssl enc -aes-256-cbc -pbkdf2 \
  -in /tmp/plain.dat -out /tmp/cipher.dat \
  -pass file:/tmp/datakey.bin

# 3) Vứt data key plaintext đi — chỉ giữ cipher.dat + datakey.enc.b64
shred -u /tmp/datakey.bin 2>/dev/null || rm -f /tmp/datakey.bin
echo "Đã mã hóa 1MB chỉ với 1 lần gọi KMS"
```

Giải mã ngược lại: gọi `Decrypt` đúng **một lần** để lấy lại data key plaintext, rồi giải mã file cục bộ.

```bash
# 4) Nhờ KMS giải mã data key (chỉ data key, không phải toàn bộ file)
aws kms decrypt \
  --ciphertext-blob fileb://<(base64 --decode /tmp/datakey.enc.b64) \
  --query Plaintext --output text | base64 --decode > /tmp/datakey.bin

# 5) Giải mã file cục bộ
openssl enc -d -aes-256-cbc -pbkdf2 \
  -in /tmp/cipher.dat -out /tmp/decrypted.dat \
  -pass file:/tmp/datakey.bin

cmp /tmp/plain.dat /tmp/decrypted.dat && echo "OK: file khớp 100%"
rm -f /tmp/datakey.bin
```

**Điểm cốt lõi để thi:** dù dữ liệu 1MB hay 1GB, ta chỉ gọi KMS **một lần** cho mỗi file (encrypt data key) và một lần khi giải mã. Dữ liệu lớn không bao giờ rời máy để gửi lên KMS — vừa nhanh, vừa né giới hạn 4KB, vừa giảm số KMS request (giảm chi phí và throttling). `GenerateDataKeyWithoutPlaintext` dùng khi bạn chỉ cần ciphertext của data key tại thời điểm tạo (mã hóa sau).

### Bước 4: Phiên bản SDK v3 (Node.js) cho luồng envelope

```javascript
// envelope.mjs — minh họa GenerateDataKey + Decrypt bằng SDK v3
import { KMSClient, GenerateDataKeyCommand, DecryptCommand } from "@aws-sdk/client-kms";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const kms = new KMSClient({ region: process.env.AWS_REGION });
const KeyId = "alias/ch46-lab";

async function encrypt(plaintext) {
  // Xin data key: Plaintext để mã hóa local, CiphertextBlob để lưu kèm
  const { Plaintext, CiphertextBlob } = await kms.send(
    new GenerateDataKeyCommand({ KeyId, KeySpec: "AES_256" })
  );
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", Plaintext, iv);
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  Plaintext.fill(0); // xóa data key plaintext khỏi RAM ngay
  return { encryptedDataKey: CiphertextBlob, iv, data };
}

async function decrypt({ encryptedDataKey, iv, data }) {
  const { Plaintext } = await kms.send(
    new DecryptCommand({ CiphertextBlob: encryptedDataKey }) // không cần KeyId với symmetric
  );
  const decipher = createDecipheriv("aes-256-cbc", Plaintext, iv);
  const out = Buffer.concat([decipher.update(data), decipher.final()]);
  Plaintext.fill(0);
  return out;
}

const env = await encrypt(Buffer.from("dữ liệu nhạy cảm rất dài..."));
console.log("Giải mã:", (await decrypt(env)).toString());
```

> Trong production thực tế, đừng tự cuộn AES như trên — dùng **AWS Encryption SDK** (client-side library) để có authenticated encryption, message format chuẩn, và **data key caching** (tái dùng data key cho nhiều bản ghi → giảm mạnh số KMS request). Đây là điểm thi: "giảm chi phí/throttling KMS khi mã hóa hàng loạt bản ghi nhỏ" → Encryption SDK với data key caching.

### Bước 5: Grant — cấp quyền tạm thời mà không sửa policy

Khi một service hoặc role cần dùng key tạm thời (vd: trong một workflow), thay vì sửa key policy, ta tạo **grant**. Grant là cơ chế cấp quyền linh hoạt, có thể thu hồi độc lập.

```bash
# Tạo một role giả lập grantee (ở đây dùng chính caller cho gọn nếu là role;
# với user thì tạo grant cho một role có sẵn). Ví dụ minh họa cú pháp:
export GRANT_TOKEN=$(aws kms create-grant \
  --key-id "$KEY_ID" \
  --grantee-principal "$ME" \
  --operations Decrypt GenerateDataKey \
  --query GrantToken --output text)
echo "Grant tạo xong (token để dùng ngay, tránh eventual consistency)"

# Liệt kê grants trên key
aws kms list-grants --key-id "$KEY_ID" \
  --query 'Grants[].{Id:GrantId,Grantee:GranteePrincipal,Ops:Operations}'
```

> Bẫy: grant mới tạo có thể chưa hiệu lực ngay do eventual consistency. Dùng `GrantToken` trả về (truyền vào `--grant-tokens` của lệnh kế tiếp) để dùng quyền **tức thì**. Thu hồi bằng `retire-grant` (grantee/principal tạo retire) hoặc `revoke-grant` (admin của key revoke).

### Bước 6: Bật automatic key rotation

```bash
aws kms enable-key-rotation --key-id "$KEY_ID"
aws kms get-key-rotation-status --key-id "$KEY_ID"
# Output: { "KeyRotationEnabled": true }
```

Automatic rotation xoay **backing key** mỗi năm (mặc định 365 ngày; nay có thể đặt 90–2560 ngày qua `--rotation-period-in-days`). Quan trọng: **Key ID, ARN, alias KHÔNG đổi**; old ciphertext vẫn giải mã được vì KMS giữ các backing key cũ. Bạn không cần re-encrypt gì cả. AWS managed key (`aws/...`) tự rotate mỗi năm và không tắt được. AWS owned key bạn không thấy/không quản. Asymmetric key và imported key material **không** rotate tự động.

### Bước 7: Khóa key chỉ dùng được qua một service bằng kms:ViaService

`kms:ViaService` giới hạn key chỉ được dùng khi request đến **gián tiếp qua một AWS service** (vd S3, EBS) trong region, không phải gọi trực tiếp. Hữu ích để đảm bảo data key chỉ phục vụ mã hóa của một service nhất định.

```bash
# Ví dụ condition (thêm vào statement AllowCallerUseKey nếu muốn siết):
#   "Condition": {
#     "StringEquals": {
#       "kms:ViaService": "s3.ap-southeast-1.amazonaws.com",
#       "kms:CallerAccount": "${ACCOUNT}"
#     }
#   }
echo "ViaService giới hạn key chỉ dùng qua s3.<region>.amazonaws.com"
```

Với condition này, gọi `aws kms decrypt` trực tiếp sẽ bị Deny, nhưng S3 thay mặt bạn gọi Decrypt thì pass — đúng pattern "key này chỉ để S3 mã hóa".

### Dọn dẹp tài nguyên

```bash
# Xóa alias trước
aws kms delete-alias --alias-name alias/ch46-lab

# Lên lịch xóa key (tối thiểu 7 ngày, KHÔNG xóa ngay được — chống mất data oan)
aws kms schedule-key-deletion --key-id "$KEY_ID" --pending-window-in-days 7

# Hủy lịch xóa nếu lỡ tay:  aws kms cancel-key-deletion --key-id "$KEY_ID"

rm -f /tmp/secret.b64 /tmp/big.b64 /tmp/dk.json /tmp/datakey.enc.b64 \
      /tmp/cipher.dat /tmp/plain.dat /tmp/decrypted.dat /tmp/key-policy.json
```

> Lưu ý chi phí: mỗi customer managed key tốn ~1 USD/tháng (tính theo tỷ lệ tới khi bị xóa) cộng phí theo số API request (20.000 request đầu/tháng miễn phí). Bạn **không xóa key ngay được** — chỉ schedule với cửa sổ 7–30 ngày. Trong thời gian chờ, key ở trạng thái `PendingDeletion` và không dùng được; nếu cần lấy lại, dùng `cancel-key-deletion`. Disable key (`disable-key`) khác xóa: tạm ngừng dùng nhưng giữ nguyên.

## 💡 Exam Tips chương 46

- **Giới hạn 4KB:** `Encrypt`/`Decrypt`/`ReEncrypt` chỉ xử lý ≤4096 bytes. Dữ liệu lớn hơn → **envelope encryption** với `GenerateDataKey`. Câu hỏi "mã hóa file lớn/blob bằng KMS" gần như luôn dẫn tới GenerateDataKey, không phải Encrypt.
- **Envelope encryption flow:** `GenerateDataKey` trả về *Plaintext data key* (mã hóa local) + *Encrypted data key* (lưu kèm dữ liệu). Decrypt data key một lần rồi giải mã cục bộ. Data lớn không bao giờ gửi lên KMS.
- **Key policy là bắt buộc và là nguồn quyền gốc:** khác mọi service khác, IAM policy một mình KHÔNG đủ cho KMS. Default key policy mở cho `root` để IAM hoạt động; nếu key policy không cho `root` và cũng không trỏ principal, không ai dùng được (kể cả admin) — phải nhờ AWS gỡ.
- **Cross-account KMS** cần đủ: (1) key policy của tài khoản chủ key cho phép principal bên kia, (2) IAM policy bên gọi cho phép `kms:Decrypt`. Đây là nguyên nhân AccessDenied kinh điển khi đọc object S3 SSE-KMS cross-account (Chương 14).
- **Automatic rotation** xoay backing key mỗi năm (đặt được 90–2560 ngày); Key ID/ARN/alias **không đổi**, ciphertext cũ vẫn giải mã được, không cần re-encrypt. Chỉ áp dụng symmetric CMK do AWS sinh key material — **không** cho asymmetric/imported material.
- **AWS managed vs customer managed vs AWS owned:** AWS managed (`aws/<service>`) tự rotate hàng năm, không tùy chỉnh policy; customer managed cho phép tự viết policy, grant, rotation, audit qua CloudTrail; AWS owned key bạn không thấy/không quản, miễn phí.
- **kms:ViaService** giới hạn key chỉ dùng gián tiếp qua một service cụ thể (vd `s3.<region>.amazonaws.com`); **kms:CallerAccount** giới hạn theo account. Hay dùng để siết data key chỉ phục vụ đúng service.
- **Grant vs key policy:** grant cấp quyền hẹp, tạm thời, thu hồi độc lập (`retire`/`revoke`), thích hợp khi service/role cần quyền ngắn hạn mà không muốn sửa policy. Grant có eventual consistency — dùng `GrantToken` để hiệu lực tức thì.
- **S3 Bucket Key** giảm tới ~99% số KMS request cho SSE-KMS (dùng bucket-level key sinh data key) → chống `ThrottlingException` và giảm chi phí ở quy mô lớn (chi tiết S3 ở Chương 14).
- **ThrottlingException / request quota:** KMS có shared quota theo region (vd cryptographic ops vài chục nghìn req/s tùy region). Khắc phục: data key caching (Encryption SDK), Bucket Key, hoặc xin tăng quota — đừng nhầm sang lỗi của S3/DynamoDB.
- **Schedule key deletion** tối thiểu 7 ngày (tối đa 30), không xóa tức thì; `disable-key` khác `schedule-key-deletion`. Multi-region keys: có một primary, replicate sang region khác, dùng chung key material để ciphertext **portable** giữa region.
- **CloudHSM vs KMS:** CloudHSM cho single-tenant, FIPS 140-2 Level 3, bạn quản key hoàn toàn (dùng khi quy định bắt buộc HSM riêng); KMS là multi-tenant managed, đủ cho hầu hết use case và tích hợp sẵn với mọi service AWS.

## Quiz chương 46 (10 câu)

**Câu 1.** Một developer cần mã hóa các file backup 500MB trước khi lưu, dùng KMS làm gốc tin cậy. Cách đúng và hiệu quả nhất?
- A. Gọi `kms:Encrypt` trực tiếp trên từng file 500MB
- B. Dùng `GenerateDataKey`, mã hóa file cục bộ bằng data key, lưu kèm encrypted data key (envelope encryption)
- C. Chia file thành các phần ≤4KB rồi gọi `Encrypt` cho từng phần
- D. Dùng SSE-C để KMS giữ key

**Câu 2.** Một IAM user đã được gắn IAM policy cho phép `kms:Decrypt` trên một CMK, nhưng vẫn bị AccessDenied khi gọi Decrypt. Key được tạo với key policy chỉ chứa một statement cho phép principal khác. Nguyên nhân?
- A. KMS bị throttle
- B. Key policy không cho phép user này (và không mở quyền cho root để IAM có hiệu lực)
- C. User thiếu quyền `sts:AssumeRole`
- D. CMK chưa bật rotation

**Câu 3.** Sau khi bật automatic key rotation cho một CMK, điều gì xảy ra với các ciphertext đã tạo trước đó?
- A. Phải re-encrypt toàn bộ vì key đã đổi
- B. Vẫn giải mã được bình thường; Key ID/ARN/alias không đổi, KMS giữ backing key cũ
- C. Mất khả năng giải mã sau 365 ngày
- D. Tự động được re-encrypt bởi KMS mỗi đêm

**Câu 4.** Một ứng dụng mã hóa hàng triệu bản ghi nhỏ và bắt đầu nhận `ThrottlingException` từ KMS. Giải pháp ít tốn kém và đúng nhất?
- A. Chuyển sang CloudHSM
- B. Dùng AWS Encryption SDK với data key caching để tái dùng data key
- C. Tạo nhiều CMK rồi round-robin
- D. Gọi `Encrypt` trực tiếp thay vì `GenerateDataKey`

**Câu 5.** Tài khoản A sở hữu bucket S3 mã hóa bằng CMK của A. Tài khoản B cần đọc object. Đã cấp bucket policy + IAM cho B nhưng vẫn AccessDenied. Còn thiếu gì?
- A. Bật versioning trên bucket
- B. Key policy của CMK (account A) phải cho phép principal của B thực hiện `kms:Decrypt`
- C. B phải tạo CMK riêng
- D. Tắt Block Public Access

**Câu 6.** Một service cần quyền `Decrypt` tạm thời trên một CMK trong một workflow ngắn, sau đó thu hồi mà không ảnh hưởng các quyền khác. Cơ chế nào phù hợp nhất?
- A. Thêm statement mới vào key policy rồi xóa sau
- B. Tạo một grant với operations `Decrypt`, thu hồi bằng `retire-grant`/`revoke-grant`
- C. Gắn IAM policy inline rồi gỡ
- D. Bật ViaService

**Câu 7.** Yêu cầu: một CMK chỉ được dùng để mã hóa thông qua S3 trong region ap-southeast-1, không cho phép gọi KMS trực tiếp. Condition nào trong key policy đáp ứng?
- A. `StringEquals { kms:ViaService: "s3.ap-southeast-1.amazonaws.com" }`
- B. `Bool { aws:SecureTransport: true }`
- C. `StringEquals { aws:PrincipalTag/team: s3 }`
- D. `IpAddress { aws:SourceIp: "10.0.0.0/8" }`

**Câu 8.** Một công ty cần mã hóa portable giữa nhiều region (cùng ciphertext giải mã được ở region khác nhau) mà không phải gọi cross-region và không phải re-encrypt. Giải pháp?
- A. Tạo CMK riêng ở mỗi region và re-encrypt khi sao chép
- B. Dùng KMS multi-region keys (primary + replica dùng chung key material)
- C. Bật automatic rotation
- D. Dùng AWS owned key

**Câu 9.** Một developer vừa lỡ chạy `schedule-key-deletion` cho CMK production. Họ cần khôi phục ngay. Điều nào ĐÚNG?
- A. Key đã bị xóa vĩnh viễn, không cứu được
- B. Trong cửa sổ chờ (tối thiểu 7 ngày), key ở trạng thái PendingDeletion; chạy `cancel-key-deletion` để khôi phục
- C. Phải mở ticket với AWS Support để khôi phục
- D. Key tự khôi phục sau 24 giờ

**Câu 10.** Một quy định bắt buộc dùng module bảo mật phần cứng single-tenant đạt FIPS 140-2 Level 3, và khách hàng phải kiểm soát hoàn toàn key material. KMS đa phần multi-tenant không đáp ứng. Dịch vụ nào phù hợp?
- A. AWS Secrets Manager
- B. AWS CloudHSM
- C. SSE-S3
- D. AWS owned keys

### Đáp án & giải thích

**Câu 1 — Đáp án B.** `Encrypt` chỉ nhận ≤4KB nên A và C bất khả thi/cồng kềnh (C còn vỡ tính toàn vẹn và tốn cực nhiều request). Envelope encryption với `GenerateDataKey` là pattern chuẩn: chỉ một lần gọi KMS, mã hóa file cục bộ. D sai: SSE-C nghĩa là *khách hàng* giữ key, KMS không tham gia.

**Câu 2 — Đáp án B.** Trong KMS, quyền có hiệu lực chỉ khi key policy cho phép — hoặc trực tiếp với principal, hoặc gián tiếp bằng cách mở cho `root` để IAM policy có tác dụng. Key policy ở đây không làm cả hai nên IAM policy vô hiệu. A/C/D không gây AccessDenied đúng tình huống (throttle ra ThrottlingException, không phải AccessDenied; AssumeRole và rotation không liên quan).

**Câu 3 — Đáp án B.** Automatic rotation đổi backing key nhưng giữ Key ID/ARN/alias và lưu các backing key cũ; ciphertext cũ vẫn giải mã được, không cần re-encrypt. A/C/D mô tả sai cơ chế — KMS không tự re-encrypt dữ liệu của bạn và không làm mất khả năng giải mã.

**Câu 4 — Đáp án B.** Data key caching trong AWS Encryption SDK tái dùng một data key cho nhiều bản ghi → giảm mạnh số lần gọi KMS, hết throttle, rẻ. A (CloudHSM) đắt và không cần thiết. C (nhiều CMK) phức tạp, vẫn có thể chạm quota tổng. D sai hoàn toàn — `Encrypt` còn tốn nhiều request hơn và vướng giới hạn 4KB.

**Câu 5 — Đáp án B.** Đọc object SSE-KMS cross-account cần cả quyền S3 lẫn `kms:Decrypt`, và quyền KMS phải được key policy của tài khoản chủ key (A) cấp cho principal B. Thiếu key policy KMS là nguyên nhân AccessDenied kinh điển. A/C/D không liên quan tới lỗi giải mã.

**Câu 6 — Đáp án B.** Grant cấp quyền hẹp, tạm thời, thu hồi độc lập (`retire-grant`/`revoke-grant`) mà không đụng tới các quyền khác — đúng nhu cầu. A sửa key policy thủ công dễ sai và không "ngắn hạn". C dùng IAM nhưng key policy mới là gốc quyền KMS. D (ViaService) là điều kiện giới hạn, không phải cơ chế cấp quyền tạm.

**Câu 7 — Đáp án A.** `kms:ViaService` giới hạn key chỉ dùng khi request đến gián tiếp qua đúng service endpoint (`s3.<region>.amazonaws.com`); gọi KMS trực tiếp sẽ bị Deny. B ép HTTPS (không liên quan service). C là ABAC theo tag. D giới hạn IP, không phải qua service.

**Câu 8 — Đáp án B.** Multi-region keys có một primary và các replica chia sẻ cùng key material và cùng key ID (khác đuôi region), nên ciphertext tạo ở region này giải mã được ở region khác mà không cần re-encrypt hay gọi cross-region. A tốn công và phải re-encrypt. C/D không giải quyết tính portable cross-region.

**Câu 9 — Đáp án B.** `schedule-key-deletion` đặt key vào PendingDeletion với cửa sổ tối thiểu 7 ngày (tối đa 30); trong thời gian đó chạy `cancel-key-deletion` để khôi phục — chính là cơ chế chống xóa nhầm. A sai (chưa xóa). C không cần Support. D sai hoàn toàn.

**Câu 10 — Đáp án B.** CloudHSM cung cấp HSM single-tenant đạt FIPS 140-2 Level 3 và khách hàng kiểm soát hoàn toàn key material — đúng yêu cầu quy định. A (Secrets Manager) quản secret, không phải HSM. C (SSE-S3) AWS quản key, không single-tenant HSM. D (AWS owned keys) khách hàng không kiểm soát gì.

## Tóm tắt chương

- KMS dùng symmetric CMK cho hầu hết use case; `Encrypt`/`Decrypt`/`ReEncrypt` chỉ xử lý **≤4KB** plaintext — dữ liệu lớn phải dùng **envelope encryption**.
- **Envelope encryption** với `GenerateDataKey`: nhận data key plaintext (mã hóa local) + encrypted data key (lưu kèm); chỉ gọi KMS một lần/đối tượng, dữ liệu lớn không rời máy.
- **Key policy là nguồn quyền gốc của KMS** — khác mọi service khác, IAM policy một mình không đủ; default key policy mở cho `root` để IAM hoạt động.
- **Cross-account KMS** cần cả key policy (tài khoản chủ key) lẫn IAM policy (bên gọi) cho `kms:Decrypt` — thiếu key policy là nguyên nhân AccessDenied kinh điển với S3 SSE-KMS.
- **Automatic key rotation** xoay backing key (90–2560 ngày, mặc định ~1 năm); Key ID/ARN/alias không đổi, ciphertext cũ vẫn giải mã được, không cần re-encrypt; không áp dụng asymmetric/imported material.
- **Phân loại key:** AWS managed (`aws/<service>`, tự rotate, không tùy chỉnh), customer managed (tự viết policy/grant/rotation, audit CloudTrail), AWS owned (không thấy, miễn phí).
- **Grant** cấp quyền hẹp/tạm thời, thu hồi độc lập (`retire`/`revoke`), có eventual consistency — dùng `GrantToken` để hiệu lực tức thì.
- **kms:ViaService** giới hạn key chỉ dùng gián tiếp qua một service cụ thể; **kms:CallerAccount** giới hạn theo account.
- **S3 Bucket Key** + **data key caching (Encryption SDK)** là hai cách chính giảm số KMS request → chống `ThrottlingException` và giảm chi phí ở quy mô lớn.
- **Multi-region keys** cho ciphertext portable giữa region (primary + replica chung key material), tránh re-encrypt và gọi cross-region.
- **Schedule key deletion** tối thiểu 7 ngày (tối đa 30), khôi phục bằng `cancel-key-deletion`; `disable-key` chỉ tạm ngừng, khác xóa.
- **CloudHSM** dùng khi quy định bắt buộc HSM single-tenant FIPS 140-2 Level 3 và kiểm soát key hoàn toàn; còn lại KMS managed multi-tenant là đủ và tích hợp sẵn S3/EBS/RDS/Lambda env vars/SQS/Secrets Manager.
