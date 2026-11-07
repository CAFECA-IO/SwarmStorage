// Info: (20261108 - Luphia) 取自 https://github.com/CAFECA-IO/CAFECA (22bb517) app/sdk/cafeca-verify.ts，未修改邏輯；更新時請整份重新複製
/**
 * Sign in with CAFECA — 伺服器端驗證（Node 18+ / Bun / Deno / Edge，依賴 viem）
 *
 *   import { createCafecaVerifier } from "./cafeca-verify";
 *   const cafeca = createCafecaVerifier({ wallet: "https://<CAFECA 錢包網域>" });
 *   const user = await cafeca.verify(response, { domain: "https://shop.example", nonce });
 *   // user.account 就是這個人在你網站上的唯一 ID
 *
 * 驗證完全在你這一端完成：用公開 RPC 呼叫使用者身分合約的 isValidSignature（ERC-1271），
 * 不需要 API key、不需要向 CAFECA 註冊，也不會把使用者的登入告訴 CAFECA 伺服器。
 */
import { createPublicClient, hashMessage, hashTypedData, http, type Address, type Hex, type TypedDataDefinition } from "viem";
import { readKycStatus, verifySignInResponse, type KycStatus, type SignInResponse, type VerifiedSignIn } from "./signin";

export type { KycStatus, SignInResponse, VerifiedSignIn };

export type CafecaConfiguration = {
  issuer: string;
  chain: { id: number; rpc: string };
  contracts: { factory: Address; keyring: Address; attestation: Address; recovery: Address; twdc?: Address; entryPoint?: Address; identityRegistry?: Address | null } | null;
};

export type VerifierOptions = {
  /** CAFECA 錢包網址；會讀取 <wallet>/.well-known/cafeca-configuration 取得鏈與合約位址 */
  wallet: string;
  /** 覆寫 RPC（建議自架節點或付費 RPC，避免依賴單一公開節點） */
  rpcUrl?: string;
  /** 直接提供設定就不會連線讀取 .well-known（離線、或想把位址寫死在程式裡） */
  config?: CafecaConfiguration;
  /** 使用者同意提供代稱時，向錢包查詢該帳戶目前的代稱（預設 true）；false 則只採用回應中自稱、未經確認的代稱 */
  resolveHandle?: boolean;
};

export function createCafecaVerifier(opts: VerifierOptions) {
  let cfg: Promise<CafecaConfiguration> | null = opts.config ? Promise.resolve(opts.config) : null;
  const loadConfig = () =>
    (cfg ??= fetch(new URL("/.well-known/cafeca-configuration", opts.wallet)).then(async (r) => {
      if (!r.ok) {
        cfg = null;
        throw new Error(`無法讀取 CAFECA 設定（HTTP ${r.status}）`);
      }
      return (await r.json()) as CafecaConfiguration;
    }));

  let client: ReturnType<typeof createPublicClient> | null = null;

  return {
    config: loadConfig,
    /**
     * 驗證錢包交回的登入結果。
     * @param domain 你的網站 origin（例：https://shop.example），必須和使用者簽署的訊息完全相同
     * @param nonce  你為這次登入產生、尚未使用過的 nonce；驗證成功後請立刻作廢
     */
    async verify(response: SignInResponse, p: { domain: string; nonce: string; channelPub?: string; now?: number }): Promise<VerifiedSignIn> {
      const c = await loadConfig();
      const pc = (client ??= createPublicClient({ transport: http(opts.rpcUrl ?? c.chain.rpc) }));
      return verifySignInResponse(response, {
        domain: p.domain,
        nonce: p.nonce,
        chainId: c.chain.id,
        attestation: c.contracts?.attestation,
        identityRegistry: c.contracts?.identityRegistry ?? undefined,
        recovery: c.contracts?.recovery,
        now: p.now,
        channelPub: p.channelPub,
        lookupHandle:
          opts.resolveHandle === false
            ? undefined
            : async (a) => {
                const r = await fetch(new URL(`/api/profile?q=${a}`, opts.wallet));
                if (!r.ok) return null;
                const h = ((await r.json()) as { handle?: string | null }).handle;
                return typeof h === "string" && /^[a-z0-9_]{3,20}$/.test(h) ? h : null;
              },
        readContract: (q) => pc.readContract(q as Parameters<typeof pc.readContract>[0]),
      });
    },

    /**
     * 目前的實名狀態（IdentityRegistry v2）：登入之後隨時可以重新查詢，撤銷、暫停、過期都會反映在 effectiveLevel。
     * 要正式實名時請同時要求 signerClass === "production"。
     */
    async identityStatus(account: Address): Promise<KycStatus | null> {
      const c = await loadConfig();
      if (!c.contracts?.identityRegistry) return null;
      const pc = (client ??= createPublicClient({ transport: http(opts.rpcUrl ?? c.chain.rpc) }));
      return readKycStatus((q) => pc.readContract(q as Parameters<typeof pc.readContract>[0]), c.contracts.identityRegistry, account);
    },

    /** 驗證簽章通道回傳的 sign_message 簽章（ERC-1271 isValidSignature(hashMessage)） */
    async verifyMessage(p: { account: Address; message: string; signature: Hex }): Promise<boolean> {
      return this.isValid(p.account, hashMessage(p.message), p.signature);
    },

    /** 驗證簽章通道回傳的 sign_typed_data 簽章 */
    async verifyTypedData(p: { account: Address; typedData: TypedDataDefinition; signature: Hex }): Promise<boolean> {
      return this.isValid(p.account, hashTypedData(p.typedData), p.signature);
    },

    async isValid(account: Address, hash: Hex, signature: Hex): Promise<boolean> {
      const c = await loadConfig();
      const pc = (client ??= createPublicClient({ transport: http(opts.rpcUrl ?? c.chain.rpc) }));
      const magic = await pc
        .readContract({ address: account, abi: ERC1271, functionName: "isValidSignature", args: [hash, signature] })
        .catch(() => "0x");
      return magic === "0x1626ba7e";
    },
  };
}

const ERC1271 = [
  { type: "function", name: "isValidSignature", stateMutability: "view", inputs: [{ type: "bytes32" }, { type: "bytes" }], outputs: [{ type: "bytes4" }] },
] as const;

/** 產生 nonce（128 bits，base64url） */
export function newNonce(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
