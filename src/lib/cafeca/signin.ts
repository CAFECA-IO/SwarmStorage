// Info: (20261108 - Luphia) 取自 https://github.com/CAFECA-IO/CAFECA (22bb517) app/src/lib/signin.ts，未修改邏輯；更新時請整份重新複製
import { hashTypedData, isAddress, keccak256, recoverTypedDataAddress, toHex, type Address, type Hex } from "viem";
import { CREDENTIAL_CLAIMS, CREDENTIAL_TTL, ZERO32, kycCredentialTypedData, type KycCredential } from "./kyc_credential";

/**
 * Sign in with CAFECA（規格 §15）— 協定定義，錢包、瀏覽器 SDK 與伺服器驗證共用。
 *
 * 第三方網站不需要向 CAFECA 註冊：
 * - 請求裡的 domain（網站 origin）會寫進使用者簽署的 EIP-712 訊息
 * - 錢包只把結果送回同一個 origin（postMessage 目標、redirect_uri、response_uri 都必須同源）
 * - 網站以公開 RPC 呼叫身分合約的 isValidSignature（ERC-1271）自行驗證，不必信任 CAFECA 伺服器
 */

export const SIGNIN_VERSION = 1;
export const MAX_TTL = 10 * 60; // 秒
/** 簽章通道最長有效期（§15.8） */
export const MAX_CHANNEL_TTL = 30 * 24 * 3600;
export const MAGIC_1271 = "0x1626ba7e";

/**
 * 網站可要求的身分資料（account 一律提供）
 * - kyc_level、handle：網站自己向鏈上／CAFECA 查詢
 * - legal_name、doc_type、nationality、pairwise_id：以 KYC Credential 提供（§16.3），使用者逐項同意
 */
export const CLAIMS = ["kyc_level", "handle", ...CREDENTIAL_CLAIMS] as const;
export type Claim = (typeof CLAIMS)[number];

export type SignInMode = "popup" | "redirect" | "post";

/** 網站產生的登入請求（透過 /dl/auth?v=1&req=<base64url(JSON)> 交給錢包） */
export type SignInRequest = {
  v: 1;
  domain: string; // 網站 origin，例：https://shop.example
  uri: string; // 發起登入的頁面
  nonce: string; // 網站後端產生的一次性值
  issuedAt: number; // Unix 秒
  expiresAt: number;
  statement?: string;
  claims?: Claim[];
  mode: SignInMode;
  redirectUri?: string; // mode=redirect：必須與 domain 同源
  responseUri?: string; // mode=post（跨裝置 QR）：必須與 domain 同源
  state?: string; // 網站自訂，原樣帶回
  /** 要求開啟簽章通道（§15.8）：pub＝網站瀏覽器產生的 P-256 ECDH 公鑰（65 bytes, base64url），ttl 秒 */
  channel?: { pub: string; ttl?: number };
};

/** 使用者簽署的訊息（EIP-712 SignIn） */
export type SignInMessage = {
  domain: string;
  uri: string;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
  statement: string;
  claims: string; // 使用者同意提供的 claims，以逗號分隔並排序
  /** 簽章通道：<id>.<網站公鑰>.<錢包公鑰>.<到期 Unix 秒>；未開啟為空字串 */
  channel: string;
};

export type SignInResponse = {
  v: 1;
  type: "cafeca:auth";
  account: Address;
  chainId: number;
  message: SignInMessage;
  signature: Hex; // ERC-1271 簽章（前 20 bytes 為 validator 位址）
  claims: { handle?: string | null };
  state?: string;
  /** 使用者同意開啟簽章通道時才有 */
  channel?: { id: string; walletPub: string; expiresAt: number };
  /** 使用者同意提供 legal_name／doc_type／nationality／pairwise_id 時才有（§16.3） */
  credential?: KycCredential;
};

export type SignInError = { v: 1; type: "cafeca:auth"; error: "access_denied" | "invalid_request"; nonce?: string; state?: string };

export const SIGNIN_TYPES = {
  SignIn: [
    { name: "domain", type: "string" },
    { name: "uri", type: "string" },
    { name: "nonce", type: "string" },
    { name: "issuedAt", type: "uint256" },
    { name: "expiresAt", type: "uint256" },
    { name: "statement", type: "string" },
    { name: "claims", type: "string" },
    { name: "channel", type: "string" },
  ],
} as const;

/** EIP-712：domain 綁定鏈與使用者自己的身分合約，簽章無法挪到其他帳戶或鏈上使用 */
export function signInHash(account: Address, chainId: number, m: SignInMessage): Hex {
  return hashTypedData({
    domain: { name: "CAFECA Sign-In", version: "1", chainId, verifyingContract: account },
    types: SIGNIN_TYPES,
    primaryType: "SignIn",
    message: { ...m, issuedAt: BigInt(m.issuedAt), expiresAt: BigInt(m.expiresAt) },
  });
}

export function claimsString(claims: readonly string[]): string {
  return [...new Set(claims)].filter((c) => (CLAIMS as readonly string[]).includes(c)).sort().join(",");
}

export function claimsDigest(claims: readonly string[]): Hex {
  return keccak256(toHex(claimsString(claims)));
}

// ───────────────────────── 編碼 ─────────────────────────

function b64urlEncode(s: string) {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string) {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

export function encodeRequest(r: SignInRequest): string {
  return b64urlEncode(JSON.stringify(r));
}

export function encodePayload(p: unknown): string {
  return b64urlEncode(JSON.stringify(p));
}

export function decodePayload<T>(s: string): T {
  return JSON.parse(b64urlDecode(s)) as T;
}

// ───────────────────────── 驗證請求（錢包端） ─────────────────────────

function originOf(u: string): string | null {
  try {
    const url = new URL(u);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** 解析並檢查登入請求；任何不合規的欄位都拒絕（錢包不會為不合規的請求簽名） */
export function parseRequest(encoded: string, now = Math.floor(Date.now() / 1000)): SignInRequest {
  let r: SignInRequest;
  try {
    r = decodePayload<SignInRequest>(encoded);
  } catch {
    throw new Error("登入請求格式錯誤");
  }
  if (r.v !== SIGNIN_VERSION) throw new Error("不支援的登入協定版本");
  const origin = originOf(r.domain);
  if (!origin || origin !== r.domain) throw new Error("網站網域格式錯誤（必須是 https 的 origin）");
  if (originOf(r.uri) !== origin) throw new Error("登入頁面與網站網域不一致");
  if (typeof r.nonce !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(r.nonce)) throw new Error("nonce 格式錯誤");
  if (!Number.isInteger(r.issuedAt) || !Number.isInteger(r.expiresAt)) throw new Error("時間格式錯誤");
  if (r.expiresAt <= now) throw new Error("登入請求已過期，請回到網站重新登入");
  if (r.issuedAt > now + 60 || r.expiresAt - r.issuedAt > MAX_TTL) throw new Error("登入請求的有效時間不合理");
  if (!["popup", "redirect", "post"].includes(r.mode)) throw new Error("不支援的回傳方式");
  if (r.mode === "redirect" && (!r.redirectUri || originOf(r.redirectUri) !== origin)) throw new Error("redirect_uri 必須與網站同源");
  if (r.mode === "post" && (!r.responseUri || originOf(r.responseUri) !== origin)) throw new Error("response_uri 必須與網站同源");
  if (r.redirectUri && originOf(r.redirectUri) !== origin) throw new Error("redirect_uri 必須與網站同源");
  if (r.statement && r.statement.length > 200) throw new Error("說明文字過長");
  if (r.channel !== undefined) {
    if (!r.channel || typeof r.channel.pub !== "string" || !/^[A-Za-z0-9_-]{87}$/.test(r.channel.pub)) throw new Error("簽章通道公鑰格式錯誤");
    const ttl = r.channel.ttl ?? 7 * 24 * 3600;
    if (!Number.isInteger(ttl) || ttl < 60 || ttl > MAX_CHANNEL_TTL) throw new Error("簽章通道有效期須介於 1 分鐘到 30 天");
    r.channel = { pub: r.channel.pub, ttl };
  }
  r.claims = (r.claims ?? []).filter((c): c is Claim => (CLAIMS as readonly string[]).includes(c));
  return r;
}

// ───────────────────────── 驗證回應（網站端） ─────────────────────────

export type VerifyOptions = {
  /** 你的網站 origin，必須與訊息中的 domain 完全相同 */
  domain: string;
  /** 你的後端發出、尚未使用過的 nonce */
  nonce: string;
  /** 呼叫合約：isValidSignature、levelOf、isPending */
  readContract: (p: { address: Address; abi: readonly unknown[]; functionName: string; args: readonly unknown[] }) => Promise<unknown>;
  chainId: number;
  attestation?: Address;
  /** IdentityRegistry v2（有提供時 kyc_level 以 v2 為準，並回傳主體類型、狀態、簽章者等級） */
  identityRegistry?: Address;
  recovery?: Address;
  /** 向 CAFECA 查詢帳戶目前的代稱（代稱存在 CAFECA 伺服器、不上鏈）；未提供時只採用回應裡自稱的代稱 */
  lookupHandle?: (account: Address) => Promise<string | null>;
  /** 若網站在登入請求中要求了簽章通道，傳入自己的通道公鑰以確認一致 */
  channelPub?: string;
  now?: number;
};

export type VerifiedSignIn = {
  account: Address;
  /** handleVerified=false 表示代稱只是回應裡自稱的，未經 CAFECA 確認，只能拿來顯示 */
  claims: {
    kyc_level?: number;
    handle?: string | null;
    handleVerified?: boolean;
    kyc?: KycStatus;
    /** 以下四項來自 KYC Credential，已驗證簽章者與 attestation nonce；使用者同意但錢包沒有資料時為 null */
    legal_name?: string | null;
    doc_type?: string | null;
    nationality?: string | null;
    /** 同一人識別碼：同一個人在你的網站永遠相同，換帳戶、恢復後也相同；不同網站之間無法串連 */
    pairwise_id?: Hex | null;
    /** 以公司身分登入（claims.kyc.subjectType === "entity"）時：統一編號與商工登記名稱 */
    entity_ubn?: string | null;
    entity_name?: string | null;
    /** credential 的簽發資訊（可存查） */
    credential?: { signer: Address; signerClass: KycStatus["signerClass"]; attestationNonce: string; issuedAt: number };
  };
  recoveryPending?: boolean;
  expiresAt: number;
  /** 使用者同意開啟的簽章通道（已由登入簽章背書） */
  channel?: SignInChannel;
};

/** v2 身分狀態（規格 §16.2）。依賴方要正式實名時應要求 signerClass === "PRODUCTION" */
export type KycStatus = {
  subjectType: "person" | "entity";
  level: number;
  effectiveLevel: number;
  status: "none" | "active" | "suspended" | "revoked";
  expiry: number;
  jurisdiction: string;
  nonce: string;
  signer: Address;
  signerClass: "none" | "prototype" | "production";
};

export type SignInChannel = { id: string; sitePub: string; walletPub: string; expiresAt: number };

export function channelString(c: SignInChannel | null): string {
  return c ? `${c.id}.${c.sitePub}.${c.walletPub}.${c.expiresAt}` : "";
}

export function parseChannelString(s: string): SignInChannel | null {
  if (!s) return null;
  const m = /^([0-9a-f]{32})\.([A-Za-z0-9_-]{87})\.([A-Za-z0-9_-]{87})\.(\d{1,12})$/.exec(s);
  if (!m) throw new Error("簽章通道格式錯誤");
  return { id: m[1], sitePub: m[2], walletPub: m[3], expiresAt: Number(m[4]) };
}

const ERC1271_ABI = [
  { type: "function", name: "isValidSignature", stateMutability: "view", inputs: [{ type: "bytes32" }, { type: "bytes" }], outputs: [{ type: "bytes4" }] },
] as const;
const LEVEL_ABI = [
  { type: "function", name: "levelOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint8" }] },
] as const;
const STATUS_ABI = [
  {
    type: "function",
    name: "statusOf",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [
      { name: "subjectType", type: "uint8" },
      { name: "level", type: "uint8" },
      { name: "effectiveLevel", type: "uint8" },
      { name: "status", type: "uint8" },
      { name: "expiry", type: "uint48" },
      { name: "issuedAt", type: "uint48" },
      { name: "jurisdiction", type: "bytes2" },
      { name: "nonce", type: "uint64" },
      { name: "signer", type: "address" },
      { name: "signerCls", type: "uint8" },
      { name: "claimsRoot", type: "bytes32" },
    ],
  },
] as const;

export async function readKycStatus(readContract: VerifyOptions["readContract"], registry: Address, account: Address): Promise<KycStatus> {
  const r = (await readContract({ address: registry, abi: STATUS_ABI, functionName: "statusOf", args: [account] })) as readonly [
    number, number, number, number, number, number, Hex, bigint, Address, number, Hex,
  ];
  const j = r[6] === "0x0000" ? "" : String.fromCharCode(parseInt(r[6].slice(2, 4), 16), parseInt(r[6].slice(4, 6), 16));
  return {
    subjectType: r[0] === 1 ? "entity" : "person",
    level: Number(r[1]),
    effectiveLevel: Number(r[2]),
    status: (["none", "active", "suspended", "revoked"] as const)[Number(r[3])] ?? "none",
    expiry: Number(r[4]),
    jurisdiction: j,
    nonce: r[7].toString(),
    signer: r[8],
    signerClass: (["none", "prototype", "production"] as const)[Number(r[9])] ?? "none",
  };
}

const PENDING_ABI = [
  { type: "function", name: "isPending", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "bool" }] },
] as const;

export async function verifySignInResponse(res: SignInResponse, o: VerifyOptions): Promise<VerifiedSignIn> {
  const now = o.now ?? Math.floor(Date.now() / 1000);
  if (!res || res.v !== SIGNIN_VERSION || res.type !== "cafeca:auth") throw new Error("不是 CAFECA 登入回應");
  if (!isAddress(res.account)) throw new Error("帳戶地址錯誤");
  const m = res.message;
  if (m.domain !== o.domain) throw new Error("登入訊息的網域不符（可能來自仿冒網站）");
  if (m.nonce !== o.nonce) throw new Error("nonce 不符");
  if (res.chainId !== o.chainId) throw new Error("鏈 ID 不符");
  if (now > m.expiresAt) throw new Error("登入已過期");
  if (m.issuedAt > now + 60) throw new Error("登入時間不合理");

  const hash = signInHash(res.account, res.chainId, m);
  const magic = await o
    .readContract({ address: res.account, abi: ERC1271_ABI, functionName: "isValidSignature", args: [hash, res.signature] })
    .catch(() => "0x");
  if (magic !== MAGIC_1271) throw new Error("簽章驗證失敗");

  const granted = m.claims ? m.claims.split(",") : [];
  const claims: VerifiedSignIn["claims"] = {};
  if (granted.includes("kyc_level") && o.identityRegistry) {
    claims.kyc = await readKycStatus(o.readContract, o.identityRegistry, res.account);
    claims.kyc_level = claims.kyc.effectiveLevel;
  } else if (granted.includes("kyc_level") && o.attestation) {
    claims.kyc_level = Number(await o.readContract({ address: o.attestation, abi: LEVEL_ABI, functionName: "levelOf", args: [res.account] }));
  }
  if (granted.includes("handle")) {
    if (o.lookupHandle) {
      claims.handle = await o.lookupHandle(res.account).catch(() => null);
      claims.handleVerified = true;
    } else {
      const h = res.claims?.handle;
      claims.handle = typeof h === "string" && /^[a-z0-9_]{3,20}$/.test(h) ? h : null;
      claims.handleVerified = false;
    }
  }
  const recoveryPending = o.recovery
    ? Boolean(await o.readContract({ address: o.recovery, abi: PENDING_ABI, functionName: "isPending", args: [res.account] }))
    : undefined;
  const credClaims = granted.filter((c) => (CREDENTIAL_CLAIMS as readonly string[]).includes(c));
  if (credClaims.length) {
    for (const c of credClaims) (claims as Record<string, unknown>)[c] = null;
    if (res.credential) {
      if (!o.identityRegistry) throw new Error("驗證 KYC Credential 需要 identityRegistry 位址");
      const kyc = claims.kyc ?? (await readKycStatus(o.readContract, o.identityRegistry, res.account));
      const v = await verifyKycCredential(res.credential, { account: res.account, audience: o.domain, nonce: o.nonce, chainId: o.chainId, identityRegistry: o.identityRegistry, kyc, granted, now });
      Object.assign(claims, v);
    }
  }
  const channel = parseChannelString(m.channel ?? "");
  if (channel) {
    if (channel.expiresAt > m.issuedAt + MAX_CHANNEL_TTL + 60) throw new Error("簽章通道有效期不合理");
    if (o.channelPub && channel.sitePub !== o.channelPub) throw new Error("簽章通道公鑰不是你的網站產生的");
  }
  return { account: res.account, claims, recoveryPending, expiresAt: m.expiresAt, channel: channel ?? undefined };
}

/**
 * 驗證 KYC Credential（§16.3）：
 * 綁定帳戶、你的網站、這次登入的 nonce；簽章者必須是目前 attestation 的簽章者，而且 attestation 仍有效、nonce 未變。
 * 揭露的 claims 必須全部包含在使用者以 Passkey 簽署的 SignIn.claims 裡。
 */
export async function verifyKycCredential(
  cred: KycCredential,
  o: { account: Address; audience: string; nonce: string; chainId: number; identityRegistry: Address; kyc: KycStatus; granted: string[]; now: number },
) {
  const m = cred?.message;
  if (!m || typeof cred.signature !== "string") throw new Error("KYC Credential 格式錯誤");
  if (m.account?.toLowerCase() !== o.account.toLowerCase()) throw new Error("KYC Credential 不屬於這個帳戶");
  if (m.audience !== o.audience) throw new Error("KYC Credential 不是發給你的網站");
  if (m.nonce !== o.nonce) throw new Error("KYC Credential 不是這次登入簽發的");
  if (!Number.isInteger(m.issuedAt) || !Number.isInteger(m.expiresAt) || m.issuedAt > o.now + 60 || m.expiresAt < o.now || m.expiresAt - m.issuedAt > CREDENTIAL_TTL)
    throw new Error("KYC Credential 已過期");
  const disclosed = m.disclosed ? m.disclosed.split(",") : [];
  if (disclosed.some((c) => !o.granted.includes(c))) throw new Error("KYC Credential 揭露了使用者未同意的資料");
  const signer = await recoverTypedDataAddress({ ...kycCredentialTypedData(o.chainId, o.identityRegistry, m), signature: cred.signature }).catch(() => null);
  if (!signer || signer.toLowerCase() !== o.kyc.signer.toLowerCase() || o.kyc.signerClass === "none") throw new Error("KYC Credential 的簽章者不是目前的 KYC 簽章者");
  if (o.kyc.status !== "active" || o.kyc.effectiveLevel < 2) throw new Error("實名證明已失效（暫停、撤銷或過期）");
  if (m.attestationNonce !== o.kyc.nonce) throw new Error("實名證明已變更，KYC Credential 失效");
  const has = (c: string) => disclosed.includes(c);
  return {
    legal_name: has("legal_name") ? m.legalName : null,
    doc_type: has("doc_type") ? m.docType : null,
    nationality: has("nationality") ? m.nationality : null,
    pairwise_id: has("pairwise_id") && m.pairwiseId !== ZERO32 ? m.pairwiseId : null,
    entity_ubn: has("entity_ubn") ? m.entityUbn : null,
    entity_name: has("entity_name") ? m.entityName : null,
    credential: { signer, signerClass: o.kyc.signerClass, attestationNonce: m.attestationNonce, issuedAt: m.issuedAt },
  };
}
