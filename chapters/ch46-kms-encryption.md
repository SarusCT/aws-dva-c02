# Chương 46: AWS KMS & Encryption

> **Trọng tâm DVA-C02:** KMS nằm ở tâm domain Security (26% đề thi) và xuất hiện gián tiếp ở hầu hết mọi chương có chữ "encryption" (S3, EBS, RDS, Lambda, SQS, Secrets Manager...). Dạng câu hỏi điển hình: chọn đúng loại key (AWS managed vs customer managed vs AWS owned) cho yêu cầu audit/rotation/cross-account; giải thích envelope encryption và vì sao GenerateDataKey tồn tại; sửa lỗi AccessDenied khi vừa có IAM vừa có key policy; chống confused deputy bằng `kms:ViaService`; xử lý `ThrottlingException` khi nhiều object dùng SSE-KMS; phân biệt automatic vs manual key rotation; cross-account decrypt cần những gì. Bạn phải thuộc giới hạn 4KB của Encrypt trực tiếp và luồng GenerateDataKey → encrypt cục bộ.

## Mục tiêu chương

- Hiểu nền tảng mã hóa: at rest vs in transit, symmetric vs asymmetric, và KMS đứng ở đâu trong bức tranh đó.
- Phân biệt rạch ròi 3 loại KMS key (AWS owned, AWS managed, customer managed) theo các trục: ai kiểm soát, rotation, key policy, chi phí, cross-account.
- Nắm vững envelope encryption: vì sao cần data key, luồng GenerateDataKey/Decrypt, và giới hạn 4KB của Encrypt trực tiếp.
- Đọc và viết được key policy; hiểu cơ chế đánh giá quyền khi kết hợp key policy + IAM + grants.
- Dùng đúng `kms:ViaService` để chống confused deputy, dùng grants cho ủy quyền tạm thời, và cấu hình cross-account KMS.
- Cấu hình key rotation (automatic vs manual), hiểu request quota & `ThrottlingException`, multi-region keys, và biết khi nào cần CloudHSM thay vì KMS.

## 46.1 Nền tảng mã hóa: at rest, in transit, symmetric, asymmetric

Trước khi chạm vào KMS, cần định vị bốn khái niệm mà đề DVA-C02 hay trộn lẫn.

**Encryption at rest** — mã hóa dữ liệu khi nằm yên trên đĩa (EBS volume, S3 object, RDS storage, DynamoDB table). Mục tiêu: nếu kẻ tấn công lấy được vật lý ổ đĩa hoặc snapshot, dữ liệu vẫn là ciphertext vô nghĩa. Đây là nơi KMS đóng vai trò chính.

**Encryption in transit** — mã hóa dữ liệu khi di chuyển trên mạng, gần như luôn là TLS/HTTPS. Bạn ép buộc bằng bucket policy với `aws:SecureTransport` (S3), security policy của ALB, hoặc `rds.force_ssl`. KMS hầu như không tham gia phần này — đừng chọn đáp án "dùng KMS để mã hóa traffic".

**Symmetric encryption** — một key duy nhất dùng cho cả mã hóa lẫn giải mã (AES-256 là chuẩn của KMS). Nhanh, phù hợp khối lượng dữ liệu lớn. Mặc định mọi KMS key là symmetric.

**Asymmetric encryption** — cặp public/private key. Public key mã hóa hoặc verify chữ ký; private key giải mã hoặc ký. KMS hỗ trợ asymmetric key (RSA, ECC) cho hai usage: `ENCRYPT_DECRYPT` và `SIGN_VERIFY`. Điểm mấu chốt cho đề thi: với asymmetric key, **private key không bao giờ rời KMS**, nhưng bạn có thể tải public key về để mã hóa offline (ví dụ một đối tác bên ngoài mã hóa dữ liệu gửi cho bạn mà không cần gọi AWS API).

KMS là **regional**: key tạo ở `us-east-1` không dùng được ở `eu-west-1` (trừ multi-region keys, mục 46.8). Mọi thao tác mã hóa/giải mã đều gọi API tới endpoint regional của KMS, và mọi lời gọi đều được ghi vào **CloudTrail** — đây là lý do lớn khiến KMS được chọn khi yêu cầu có chữ "audit who used the key".

> 💡 **Exam Tip:** "Audit trail of key usage" → CloudTrail tự động ghi mọi `Encrypt`/`Decrypt`/`GenerateDataKey` lên KMS key. Nếu yêu cầu là "biết ai/khi nào đã giải mã dữ liệu", bạn cần **customer managed key** (hoặc AWS managed key) để CloudTrail log có ý nghĩa — KMS chính là dịch vụ cung cấp audit trail này, không cần dựng thêm gì.

## 46.2 KMS key là gì và ba loại key

KMS key (trước đây gọi là CMK — Customer Master Key, AWS đã đổi tên thành "KMS key") là một logical resource trong tài khoản, được nhận diện bằng **key ID** (UUID), **ARN**, hoặc **alias** (`alias/my-app-key`). Material mã hóa thực sự (AES-256 key bytes) được lưu và dùng **bên trong các module HSM của AWS**, không bao giờ xuất ra dạng plaintext ra ngoài KMS. Bạn không bao giờ thấy được giá trị key — bạn chỉ gửi data lên và nhận về ciphertext/plaintext.

Có ba loại key, phân biệt theo "ai sở hữu và kiểm soát":

| Tiêu chí | AWS owned key | AWS managed key | Customer managed key (CMK) |
|---|---|---|---|
| Hiển thị trong tài khoản bạn | Không | Có (`aws/s3`, `aws/rds`...) | Có (bạn tạo) |
| Ai tạo | AWS, dùng chung nhiều tài khoản | AWS, riêng tài khoản bạn | Bạn |
| Sửa được key policy | Không | Không (AWS quản lý) | Có (toàn quyền) |
| Rotation | AWS quản lý | Bắt buộc, **mỗi năm** (1 năm), không tắt được | Tùy chọn: bật automatic (mặc định ~365 ngày, cấu hình 90–2560 ngày) hoặc manual |
| Cross-account dùng được | Không | Không | Có |
| Grants | Không | Có (giới hạn) | Có |
| Chi phí | Miễn phí | Miễn phí (chỉ trả API calls) | $1/tháng/key + API calls |
| CloudTrail log | Có nhưng ít ngữ cảnh | Có | Có, đầy đủ |

**AWS owned key**: dùng nội bộ AWS, ví dụ mã hóa metadata. Bạn không thấy, không kiểm soát, không trả tiền. Hiếm khi là đáp án đúng trừ khi câu hỏi nói "no overhead, no cost, no audit requirement".

**AWS managed key**: AWS tạo riêng cho mỗi service bạn dùng trong tài khoản, tên dạng `aws/<service>` (`aws/s3`, `aws/ebs`, `aws/secretsmanager`). Khi bạn bật SSE-KMS trên S3 mà không chỉ định key, S3 dùng `aws/s3`. Bạn không sửa được key policy, rotation cố định 1 năm. Phù hợp khi muốn KMS encryption với effort tối thiểu nhưng **không cần cross-account và không cần kiểm soát policy**.

**Customer managed key**: bạn tạo, viết key policy, bật/tắt, lên lịch xóa, bật rotation, cấp grants, dùng cross-account. Đây là đáp án mặc định khi câu hỏi có bất kỳ chữ nào sau: "custom key policy", "cross-account", "control rotation", "disable the key", "fine-grained audit".

> 💡 **Exam Tip:** Phân biệt nhanh: "least operational overhead + still want KMS audit" thường là **AWS managed key**; "cross-account access" hoặc "custom key policy" hoặc "control over rotation" thì **bắt buộc customer managed key**. AWS owned key chỉ đúng khi câu hỏi nhấn mạnh "no additional cost, no management, no audit".

Tạo một customer managed key bằng CLI:

```bash
# Tạo symmetric CMK (mặc định ENCRYPT_DECRYPT, SYMMETRIC_DEFAULT)
aws kms create-key \
  --description "App data encryption key" \
  --tags TagKey=app,TagValue=orders
# => trả về KeyMetadata.KeyId

# Gắn alias cho dễ tham chiếu trong code
aws kms create-alias \
  --alias-name alias/orders-key \
  --target-key-id <KeyId>
```

## 46.3 Symmetric vs Asymmetric KMS key & các key spec

Khi tạo key, bạn chọn `KeySpec` và `KeyUsage`:

| KeySpec | Loại | KeyUsage hỗ trợ | Dùng cho |
|---|---|---|---|
| `SYMMETRIC_DEFAULT` (AES-256) | Symmetric | ENCRYPT_DECRYPT | Mặc định; envelope encryption, SSE |
| `RSA_2048/3072/4096` | Asymmetric | ENCRYPT_DECRYPT hoặc SIGN_VERIFY | Mã hóa offline, chữ ký số |
| `ECC_NIST_P256/384/521`, `ECC_SECG_P256K1` | Asymmetric | SIGN_VERIFY | Chữ ký số |
| `HMAC_*` | HMAC | GENERATE_VERIFY_MAC | Mã xác thực thông điệp |

Với **symmetric key**, các service AWS (S3, EBS, RDS...) chỉ làm việc được với `SYMMETRIC_DEFAULT`. Đề thi gần như luôn xoay quanh symmetric key. Asymmetric chỉ xuất hiện khi câu hỏi mô tả "external party encrypts without AWS credentials" (họ dùng public key) hoặc "digitally sign a message" (dùng private key qua `Sign`/`Verify`).

```bash
# Tải public key của asymmetric key về để bên ngoài mã hóa offline
aws kms get-public-key --key-id alias/my-rsa-key \
  --query PublicKey --output text | base64 -d > public_key.der
```

> 💡 **Exam Tip:** "External users must encrypt data they send us, but must NOT be able to decrypt it, and have no AWS credentials" → **asymmetric KMS key**: phát public key cho họ mã hóa, chỉ bạn (giữ private key trong KMS) mới `Decrypt` được.

## 46.4 Encrypt/Decrypt/GenerateDataKey API & giới hạn 4KB

KMS cung cấp ba API mã hóa cốt lõi:

- **`Encrypt`**: gửi plaintext (tối đa **4KB = 4096 bytes**) lên KMS, nhận ciphertext. Dữ liệu thực sự được mã hóa bên trong KMS bằng key material.
- **`Decrypt`**: gửi ciphertext lên, KMS tự nhận biết key nào đã mã hóa (key ID nhúng trong ciphertext blob) và trả về plaintext. **Bạn không cần chỉ định key ID khi decrypt với symmetric key** — nhưng nên chỉ định để chống nhầm key (best practice). Caller cần quyền `kms:Decrypt`.
- **`GenerateDataKey`**: KMS tạo một data key ngẫu nhiên (ví dụ AES-256), trả về **cả hai**: plaintext data key (để bạn mã hóa cục bộ) và encrypted data key (đã mã hóa bằng KMS key, để lưu kèm dữ liệu). Đây là nền tảng của envelope encryption.

Giới hạn 4KB của `Encrypt` là điểm thi kinh điển. Nếu dữ liệu lớn hơn 4KB, **bạn không thể gọi `Encrypt` trực tiếp** — phải dùng envelope encryption (mục 46.5).

```javascript
// AWS SDK for JavaScript v3 — Encrypt trực tiếp dữ liệu nhỏ (<4KB)
import { KMSClient, EncryptCommand, DecryptCommand } from "@aws-sdk/client-kms";

const kms = new KMSClient({ region: "us-east-1" });

// Mã hóa một secret nhỏ (ví dụ API token)
const enc = await kms.send(new EncryptCommand({
  KeyId: "alias/orders-key",
  Plaintext: Buffer.from("super-secret-token"), // tối đa 4096 bytes
}));
// enc.CiphertextBlob là Uint8Array — lưu thẳng vào DB/file

// Giải mã: không cần KeyId vì key ID nằm trong ciphertext blob
const dec = await kms.send(new DecryptCommand({
  CiphertextBlob: enc.CiphertextBlob,
}));
console.log(Buffer.from(dec.Plaintext).toString()); // super-secret-token
```

> 💡 **Exam Tip:** "Encrypt a 1MB file with KMS" → KHÔNG gọi `Encrypt` (giới hạn 4KB). Đáp án đúng là **envelope encryption**: gọi `GenerateDataKey`, dùng plaintext data key mã hóa file cục bộ, lưu encrypted data key kèm file. Nhớ con số **4KB** — nó xuất hiện rất nhiều.

## 46.5 Envelope encryption — vì sao và flow chi tiết

Envelope encryption giải quyết hai vấn đề: (1) giới hạn 4KB của KMS, (2) hiệu năng — nếu mỗi block dữ liệu phải gọi network tới KMS thì cực chậm và tốn tiền. Ý tưởng: **dùng KMS key để mã hóa một data key, rồi dùng data key đó mã hóa dữ liệu lớn cục bộ**. "Phong bì" ở đây là: dữ liệu được bọc bởi data key, data key lại được bọc bởi KMS key.

Luồng mã hóa (encrypt):

1. Gọi `GenerateDataKey(KeyId)` → KMS trả về `Plaintext` (data key dạng rõ) và `CiphertextBlob` (chính data key đó đã được mã hóa bằng KMS key).
2. Dùng `Plaintext` data key + thuật toán AES cục bộ để mã hóa dữ liệu lớn (1MB, 1GB...).
3. **Xóa plaintext data key khỏi bộ nhớ** ngay sau khi dùng.
4. Lưu trữ: `[encrypted data key (CiphertextBlob)] + [ciphertext dữ liệu]` cạnh nhau.

Luồng giải mã (decrypt):

1. Đọc encrypted data key từ storage.
2. Gọi `Decrypt(CiphertextBlob)` → KMS trả về plaintext data key.
3. Dùng plaintext data key giải mã dữ liệu cục bộ.
4. Xóa plaintext data key khỏi bộ nhớ.

Điểm tinh tế: chỉ **một lời gọi KMS** cho toàn bộ một file lớn, thay vì gọi liên tục. Đây chính xác là cách S3 SSE-KMS, EBS, RDS hoạt động bên dưới — chúng gọi `GenerateDataKey` cho mỗi object/volume và lưu encrypted data key kèm metadata.

```javascript
import { KMSClient, GenerateDataKeyCommand, DecryptCommand } from "@aws-sdk/client-kms";
import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

const kms = new KMSClient({ region: "us-east-1" });

// === ENCRYPT dữ liệu lớn ===
async function envelopeEncrypt(plaintextBuffer) {
  // 1. Lấy data key 256-bit từ KMS
  const { Plaintext, CiphertextBlob } = await kms.send(new GenerateDataKeyCommand({
    KeyId: "alias/orders-key",
    KeySpec: "AES_256", // hoặc NumberOfBytes: 32
  }));

  // 2. Mã hóa cục bộ bằng AES-256-GCM
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Plaintext, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintextBuffer), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // 3. Trả về để lưu: encrypted data key + iv + authTag + ciphertext
  return { encryptedDataKey: CiphertextBlob, iv, authTag, ciphertext };
  // Plaintext data key tự bị GC; production nên ghi đè buffer
}

// === DECRYPT ===
async function envelopeDecrypt({ encryptedDataKey, iv, authTag, ciphertext }) {
  // 1. Nhờ KMS giải mã data key
  const { Plaintext } = await kms.send(new DecryptCommand({
    CiphertextBlob: encryptedDataKey,
  }));
  // 2. Giải mã cục bộ
  const decipher = createDecipheriv("aes-256-gcm", Plaintext, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
```

Một biến thể đáng nhớ: **`GenerateDataKeyWithoutPlaintext`** — chỉ trả về encrypted data key, không trả plaintext. Dùng khi bạn muốn pre-generate data key để dùng sau (lúc đó mới gọi `Decrypt` lấy plaintext). Hữu ích cho mô hình "tạo key bây giờ, dùng ở thời điểm khác".

> 💡 **Exam Tip:** Phân biệt `Encrypt` vs `GenerateDataKey`: `Encrypt` dùng KMS key mã hóa trực tiếp data nhỏ (≤4KB); `GenerateDataKey` trả về data key (plaintext + encrypted) để bạn tự mã hóa data lớn cục bộ. Câu hỏi "minimize calls to KMS while encrypting large/many objects" → envelope encryption với data key (có thể tái dùng data key qua **data key caching** của Encryption SDK, mục 46.6).

## 46.6 AWS Encryption SDK & data key caching

Tự viết AES-GCM, quản lý IV, authTag, format ciphertext là dễ sai. **AWS Encryption SDK** là thư viện client-side (Java, Python, C, JS, .NET) đóng gói toàn bộ best practice envelope encryption: nó tự gọi `GenerateDataKey`, tự định dạng một message format chứa encrypted data key + ciphertext + thông tin thuật toán, và hỗ trợ **encryption context** (cặp key-value gắn vào để AAD — additional authenticated data, được verify khi decrypt).

Tính năng đắt giá cho đề thi: **data key caching**. Mặc định Encryption SDK tạo data key mới cho mỗi lần mã hóa — an toàn nhất nhưng tốn nhiều lời gọi KMS. Với khối lượng lớn (hàng nghìn message/giây), bạn bật **local data key caching** để tái sử dụng một data key cho nhiều message, giảm số lần gọi KMS (giảm chi phí + tránh `ThrottlingException`). Bạn cấu hình `CachingCryptoMaterialsManager` với giới hạn: số lần dùng tối đa (`max messages`), thời gian sống tối đa (`max age`), và số bytes tối đa per data key. Đây là sự đánh đổi **bảo mật ↔ chi phí/hiệu năng**: tái dùng data key càng nhiều thì càng rẻ nhưng blast radius khi lộ một data key càng lớn.

> 💡 **Exam Tip:** Câu hỏi "ứng dụng mã hóa hàng triệu message, chi phí KMS API quá cao / bị throttle" → **AWS Encryption SDK với data key caching**. Đây là tính năng được hỏi đích danh khi cần giảm số lần gọi `GenerateDataKey`.

## 46.7 Key policy, IAM & grants — cơ chế đánh giá quyền

Đây là chủ đề gây nhầm lẫn nhất. KMS key luôn có một **key policy** (resource-based policy gắn trực tiếp vào key). Khác với hầu hết resource khác trên AWS, với KMS **key policy là gốc của mọi quyền** — IAM policy một mình KHÔNG đủ trừ khi key policy cho phép IAM được dùng.

Có hai mô hình:

**Default key policy** (khi tạo key qua console với tùy chọn mặc định): chứa một statement trao toàn quyền `kms:*` cho **root của account** trên key, kèm điều kiện. Statement này có ý nghĩa: "cho phép IAM policies trong account này điều khiển quyền truy cập key". Tức là khi có dòng `Principal: {"AWS": "arn:aws:iam::<account>:root"}` với `Action: kms:*`, các IAM policy của user/role trong account đó MỚI có hiệu lực. Đây là pattern khuyến nghị: ủy quyền cho IAM.

**Custom key policy**: bạn liệt kê tường minh principal nào được làm gì. Nếu key policy KHÔNG có statement trao quyền cho account root (không ủy quyền IAM), thì dù IAM policy của user có `kms:Decrypt`, user vẫn bị từ chối — vì key policy không cho phép.

Quy tắc đánh giá: một request lên KMS được ALLOW nếu **(key policy cho phép trực tiếp) HOẶC (key policy ủy quyền cho IAM VÀ IAM policy cho phép) HOẶC (có grant phù hợp)** — và không có explicit deny nào. Cross-account thì cần CẢ key policy (của account sở hữu key) lẫn IAM policy (của account caller) — giống pattern S3 cross-account.

Ví dụ key policy ủy quyền IAM + cho phép một role cụ thể decrypt:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "EnableIAMUserPermissions",
      "Effect": "Allow",
      "Principal": { "AWS": "arn:aws:iam::111122223333:root" },
      "Action": "kms:*",
      "Resource": "*"
    },
    {
      "Sid": "AllowAppRoleDecrypt",
      "Effect": "Allow",
      "Principal": { "AWS": "arn:aws:iam::111122223333:role/orders-app" },
      "Action": ["kms:Decrypt", "kms:GenerateDataKey"],
      "Resource": "*"
    }
  ]
}
```

**Grants** — cơ chế trao quyền tạm thời, hạt mịn, dùng programmatic mà không sửa key policy. Một grant cho phép một principal (thường là một AWS service hoặc role) thực hiện các grant operation cụ thể (`Decrypt`, `GenerateDataKey`...) trên key, có thể giới hạn bằng encryption context (`GrantConstraints`). Service như Lambda, RDS thường tạo grant tự động để được dùng key trong thời gian xử lý, rồi `RetireGrant`/`RevokeGrant` khi xong. Grant phù hợp khi cần ủy quyền ngắn hạn cho nhiều principal mà không muốn key policy phình to.

```bash
# Tạo grant cho một role được GenerateDataKey, ràng buộc encryption context
aws kms create-grant \
  --key-id alias/orders-key \
  --grantee-principal arn:aws:iam::111122223333:role/worker \
  --operations GenerateDataKey Decrypt \
  --constraints EncryptionContextSubset={app=orders}
```

> 💡 **Exam Tip:** Lỗi `AccessDenied` khi gọi KMS dù IAM policy đã có `kms:Decrypt`? Nguyên nhân kinh điển: **key policy không ủy quyền cho IAM** (thiếu statement trao quyền cho account root). Sửa key policy, không phải sửa IAM. Ngược lại, nếu key policy đã mở cho root mà vẫn deny → kiểm tra IAM policy thiếu permission hoặc có explicit deny / SCP.

## 46.8 ViaService, cross-account & multi-region keys

**`kms:ViaService` condition** giới hạn key chỉ được dùng khi request đến **thông qua một service AWS cụ thể** trong region cụ thể (`s3.us-east-1.amazonaws.com`, `dynamodb.us-east-1.amazonaws.com`). Đây là vũ khí chống **confused deputy**: bạn cho phép một role dùng key, nhưng chỉ khi nó đang thao tác qua S3 — không cho role đó tự gọi `Decrypt` trực tiếp để rút plaintext data key ra. Ví dụ điều kiện:

```json
"Condition": {
  "StringEquals": {
    "kms:ViaService": "s3.us-east-1.amazonaws.com",
    "kms:CallerAccount": "111122223333"
  }
}
```

**Cross-account KMS**: để account B dùng key của account A, cần hai mặt — (1) key policy của A cho phép principal của B; (2) IAM policy trong B cho phép principal đó gọi `kms:Decrypt` lên ARN key của A. Thiếu một trong hai là AccessDenied. Đây là biến thể của câu hỏi kinh điển "cross-account S3 object encrypted với SSE-KMS": người ở account B đọc object trong bucket A phải có quyền lên CẢ bucket (S3) lẫn key (KMS) — nếu key là `aws/s3` (AWS managed) thì KHÔNG share cross-account được, buộc phải dùng **customer managed key**.

**Multi-region keys**: bình thường KMS key bị khóa trong một region. Multi-region key cho phép bạn tạo một **primary key** ở region này rồi **replica** sang region khác, các bản replica chia sẻ cùng key material và cùng key ID (khác phần region trong ARN). Lợi ích: ciphertext mã hóa ở region A có thể giải mã ở region B mà không cần re-encrypt — phục vụ disaster recovery, global table, active-active multi-region. Mỗi replica vẫn có key policy riêng và được quản lý độc lập (có thể bật/tắt rotation độc lập). Lưu ý: chúng là các key độc lập về mặt quản lý nhưng tương thích về crypto.

> 💡 **Exam Tip:** "Cross-region disaster recovery — dữ liệu mã hóa ở Region A phải giải mã được ở Region B mà không re-encrypt" → **multi-region KMS keys**. "Cross-account decrypt object S3 SSE-KMS" → bắt buộc **customer managed key** (AWS managed `aws/s3` không share cross-account được) + quyền hai phía.

## 46.9 Key rotation, deletion & request quotas

**Automatic key rotation** (customer managed symmetric key): bật một flag, KMS tự tạo key material mới theo chu kỳ (mặc định **365 ngày**, từ 2024 cấu hình được **90–2560 ngày**). Quan trọng: **key ID, ARN, alias không đổi**; KMS giữ lại các phiên bản key material cũ để giải mã ciphertext cũ. Ứng dụng không cần biết gì — ciphertext cũ vẫn decrypt được, dữ liệu mới mã hóa bằng material mới. AWS managed key rotation cố định 1 năm, không tắt được. Asymmetric key và imported key material **không hỗ trợ automatic rotation**.

**Manual rotation**: bạn tự tạo key MỚI (key ID khác) và cập nhật **alias** trỏ sang key mới. Ciphertext cũ vẫn cần key cũ để giải mã (nên giữ key cũ, đừng xóa). Dùng khi cần rotate key material mà bạn tự import (`EXTERNAL` origin) hoặc asymmetric key.

**Xóa key**: không xóa ngay được — KMS bắt **schedule deletion** với waiting period **7–30 ngày** (mặc định 30). Trong thời gian chờ key ở trạng thái `PendingDeletion`, không dùng được, nhưng có thể `CancelKeyDeletion`. Lý do: xóa key = vĩnh viễn mất khả năng giải mã mọi ciphertext đã mã hóa bằng key đó. Thay vì xóa, thường nên **disable key** (`DisableKey`) — reversible.

```bash
aws kms enable-key-rotation --key-id alias/orders-key --rotation-period-in-days 180
aws kms schedule-key-deletion --key-id <KeyId> --pending-window-in-days 7
aws kms disable-key --key-id <KeyId>   # an toàn hơn, đảo ngược được
```

**Request quotas & `ThrottlingException`**: KMS có quota số request/giây cho các cryptographic operation (shared cho `Encrypt`, `Decrypt`, `GenerateDataKey`...), mặc định ở mức hàng chục nghìn req/s mỗi region tùy operation và region. Khi vượt, KMS trả `ThrottlingException` (HTTP 400). Tình huống kinh điển: S3 với SSE-KMS, mỗi object upload/download gọi KMS một lần → workload lớn dễ bị throttle. Hai cách giảm tải:

1. **S3 Bucket Key** — S3 dùng một data key cấp bucket để mã hóa nhiều object, giảm số lần gọi KMS tới ~99% (chi tiết ở Chương 14).
2. **Data key caching** với AWS Encryption SDK (mục 46.6) cho workload tự quản.
3. Request quota increase qua Service Quotas, hoặc retry với exponential backoff (SDK tự làm với jitter).

> 💡 **Exam Tip:** `ThrottlingException` từ KMS khi xử lý nhiều object SSE-KMS → bật **S3 Bucket Key** (giảm gọi KMS), hoặc dùng **data key caching**, hoặc xin tăng quota. Đừng chọn "đổi sang SSE-S3" nếu yêu cầu cần audit/control của KMS.

## 46.10 KMS tích hợp với các service & CloudHSM vs KMS

KMS là backbone encryption-at-rest của gần như mọi service. Bạn không mã hóa thủ công — chỉ trỏ service tới một KMS key:

- **S3**: SSE-KMS, DSSE-KMS, S3 Bucket Key (Chương 14).
- **EBS / EFS**: encryption at rest, snapshot mã hóa kế thừa key (Chương 5).
- **RDS / Aurora / DynamoDB**: encryption at rest chỉ bật được lúc tạo (RDS), DynamoDB mã hóa mặc định (Chương 8, 31).
- **Lambda environment variables**: mã hóa mặc định bằng `aws/lambda`; bật CMK + client-side encryption helper cho secret nhạy cảm — đề hay hỏi "encrypt sensitive env var" (Chương 28).
- **SQS / SNS**: SSE với KMS (`KmsMasterKeyId`); message ở rest được mã hóa (Chương 21, 22).
- **Secrets Manager / SSM Parameter Store SecureString**: mã hóa value bằng KMS (Chương 47).
- **CloudWatch Logs**: log group mã hóa bằng KMS key (Chương 25).

Khi cấu hình, bạn cần đảm bảo IAM role của service/principal có quyền `kms:Decrypt` (và `kms:GenerateDataKey` để ghi) lên key, đồng thời key policy cho phép — đây là nguồn lỗi AccessDenied phổ biến nhất trong production.

**CloudHSM vs KMS** — câu so sánh hay xuất hiện:

| Tiêu chí | AWS KMS | AWS CloudHSM |
|---|---|---|
| Mô hình | Managed, multi-tenant (HSM dùng chung, validated FIPS 140-2 Level 3) | Single-tenant, dedicated HSM cho riêng bạn |
| Ai kiểm soát key | AWS quản lý hạ tầng; bạn quản lý quyền | **Bạn toàn quyền**, AWS không truy cập được |
| Tích hợp service AWS | Native với hầu hết service | Hạn chế (qua custom key store có thể nối KMS↔CloudHSM) |
| Symmetric & asymmetric | Có (giới hạn) | Đầy đủ, nhiều thuật toán hơn, hỗ trợ PKCS#11/JCE/CNG |
| Khi nào dùng | Mặc định cho mọi nhu cầu encryption-at-rest | Yêu cầu compliance bắt buộc single-tenant HSM, kiểm soát tuyệt đối key, hoặc workload cryptographic chuyên dụng (SSL offload, CA) |

KMS là lựa chọn mặc định. CloudHSM chỉ đúng khi câu hỏi nhấn mạnh "dedicated/single-tenant HSM", "full control, AWS cannot access keys", "FIPS 140-2 Level 3 với toàn quyền quản lý", hoặc cần custom key store. Bạn cũng có thể tạo **KMS custom key store** backed by CloudHSM để vừa có tích hợp KMS vừa giữ key trong HSM riêng.

> 💡 **Exam Tip:** "Regulatory requirement: keys in a single-tenant, dedicated hardware module that AWS cannot access" → **CloudHSM**. Mọi nhu cầu encryption-at-rest thông thường (S3/EBS/RDS) → **KMS**. Đừng chọn CloudHSM chỉ vì nghe "bảo mật hơn" — nó tốn kém và phức tạp hơn nhiều.

---

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
