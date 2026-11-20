import { useEffect, useState } from 'react';
import { getWallets } from '@wallet-standard/app';
import type { Wallet, WalletAccount } from '@wallet-standard/base';

/**
 * Info: (20261120 - Luphia)
 * 瀏覽器中的 Solana 錢包 (Wallet Standard：Phantom、Solflare、Backpack…)
 * 不載入錢包 SDK；只用標準功能：連線、簽署交易 (或簽署並送出)、簽署訊息
 */

const CONNECT = 'standard:connect';
const SIGN_TX = 'solana:signTransaction';
const SIGN_SEND_TX = 'solana:signAndSendTransaction';
const SIGN_MESSAGE = 'solana:signMessage';
export const SOLANA_CHAIN = 'solana:mainnet';

type TFeature = Record<string, (...args: unknown[]) => Promise<unknown>>;
const feature = (wallet: Wallet, name: string) => (wallet.features as Record<string, TFeature | undefined>)[name];

export const isSolanaWallet = (wallet: Wallet) =>
  wallet.chains.some(chain => chain.startsWith('solana:')) && !!feature(wallet, CONNECT) && (!!feature(wallet, SIGN_TX) || !!feature(wallet, SIGN_SEND_TX));

// Info: (20261120 - Luphia) 已安裝的 Solana 錢包 (錢包晚載入時會自動加入)
export function useSolanaWallets(): Wallet[] {
  const [wallets, setWallets] = useState<Wallet[]>([]);
  useEffect(() => {
    const api = getWallets();
    const update = () => setWallets(api.get().filter(isSolanaWallet));
    update();
    const offRegister = api.on('register', update);
    const offUnregister = api.on('unregister', update);
    return () => {
      offRegister();
      offUnregister();
    };
  }, []);
  return wallets;
}

export async function connectWallet(wallet: Wallet): Promise<WalletAccount> {
  const existing = wallet.accounts.find(a => a.chains.some(c => c.startsWith('solana:')));
  if (existing) return existing;
  const result = (await feature(wallet, CONNECT)!.connect()) as { accounts: readonly WalletAccount[] };
  const account = result.accounts.find(a => a.chains.some(c => c.startsWith('solana:'))) ?? result.accounts[0];
  if (!account) throw new Error('The wallet did not share an account');
  return account;
}

/**
 * Info: (20261120 - Luphia)
 * 簽署交易：錢包支援只簽署時回傳簽好的交易 (由伺服器送出)；否則讓錢包簽署並送出，回傳交易簽章
 */
export async function signPayment(wallet: Wallet, account: WalletAccount, transaction: Uint8Array): Promise<{ signed: Uint8Array } | { signature: Uint8Array }> {
  const signOnly = feature(wallet, SIGN_TX);
  if (signOnly) {
    const [result] = (await signOnly.signTransaction({ account, transaction, chain: SOLANA_CHAIN })) as { signedTransaction: Uint8Array }[];
    return { signed: result.signedTransaction };
  }
  const [result] = (await feature(wallet, SIGN_SEND_TX)!.signAndSendTransaction({ account, transaction, chain: SOLANA_CHAIN })) as { signature: Uint8Array }[];
  return { signature: result.signature };
}

export const canSignMessage = (wallet: Wallet) => !!feature(wallet, SIGN_MESSAGE);

export async function signText(wallet: Wallet, account: WalletAccount, text: string): Promise<Uint8Array> {
  const sign = feature(wallet, SIGN_MESSAGE);
  if (!sign) throw new Error(`${wallet.name} can’t sign messages`);
  const [result] = (await sign.signMessage({ account, message: new TextEncoder().encode(text) })) as { signature: Uint8Array }[];
  return result.signature;
}

export const toBase64 = (bytes: Uint8Array) => {
  let binary = '';
  bytes.forEach(b => (binary += String.fromCharCode(b)));
  return btoa(binary);
};

export const fromBase64 = (text: string) => Uint8Array.from(atob(text), c => c.charCodeAt(0));

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function toBase58(bytes: Uint8Array): string {
  let value = BigInt(0);
  bytes.forEach(b => (value = value * BigInt(256) + BigInt(b)));
  let out = '';
  while (value > BigInt(0)) {
    out = BASE58[Number(value % BigInt(58))] + out;
    value /= BigInt(58);
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = '1' + out;
  }
  return out;
}

// Info: (20261120 - Luphia) 使用者按下取消時錢包丟出的錯誤
export const isUserRejection = (err: unknown) => err instanceof Error && /reject|denied|cancel/i.test(`${err.name} ${err.message}`);
