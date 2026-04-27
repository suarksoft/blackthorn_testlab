"use client";

import { useEffect, useMemo, useState } from "react";
import { getWallets } from "@wallet-standard/app";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import {
  StandardConnect,
  StandardDisconnect,
  type StandardConnectFeature,
  type StandardDisconnectFeature,
} from "@wallet-standard/features";
import {
  SolanaSignTransaction,
  type SolanaSignTransactionFeature,
} from "@solana/wallet-standard-features";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";

type ApiResponse = {
  ok: boolean;
  status: number;
  data: unknown;
  headers: Record<string, string>;
  rawText: string;
};

const CLUSTERS = ["devnet", "testnet", "mainnet-beta"] as const;
type Cluster = (typeof CLUSTERS)[number];
const RPC_ENDPOINTS: Record<Cluster, string> = {
  devnet: "https://api.devnet.solana.com",
  testnet: "https://api.testnet.solana.com",
  "mainnet-beta": "https://api.mainnet-beta.solana.com",
};
const DEVNET_RPC = RPC_ENDPOINTS.devnet;

type PageId =
  | "welcome"
  | "setup"
  | "scenario"
  | "analyze"
  | "batch"
  | "stream"
  | "replay"
  | "audit"
  | "mcp"
  | "x402";

type ScenarioMeta = {
  type: "signature" | "unsigned" | "real-devnet" | "wallet-signed" | "wallet-sent" | "";
  note: string;
  signature?: string;
  payer?: string;
  recipient?: string;
  walletName?: string;
  lamports?: number;
};

type LegacySolanaProvider = {
  isConnected?: boolean;
  publicKey?: { toBase58(): string };
  connect: (input?: { onlyIfTrusted?: boolean }) => Promise<{ publicKey?: { toBase58(): string } } | void>;
  disconnect?: () => Promise<void>;
  signTransaction: (transaction: VersionedTransaction) => Promise<VersionedTransaction>;
};

type WalletOption = {
  id: string;
  kind: "standard" | "legacy";
  name: string;
  wallet?: Wallet;
  provider?: LegacySolanaProvider;
};

type ConnectedWalletState = {
  walletId: string;
  walletName: string;
  kind: "standard" | "legacy";
  address: string;
  account?: WalletAccount;
  wallet?: Wallet;
  provider?: LegacySolanaProvider;
};

type WalletWindow = Window &
  typeof globalThis & {
    solana?: LegacySolanaProvider & {
      isPhantom?: boolean;
      isBackpack?: boolean;
      isSolflare?: boolean;
      isSwig?: boolean;
    };
    phantom?: { solana?: LegacySolanaProvider };
    backpack?: { solana?: LegacySolanaProvider };
    solflare?: LegacySolanaProvider;
    coinbaseSolana?: LegacySolanaProvider;
    swig?: LegacySolanaProvider | { solana?: LegacySolanaProvider };
  };

function getRpcUrl(cluster: Cluster): string {
  return RPC_ENDPOINTS[cluster];
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function safeJsonParseObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function formatSol(lamports: number | null): string {
  if (lamports == null) return "-";
  return `${(lamports / 1_000_000_000).toFixed(4)} SOL`;
}

function getConnectFeature(wallet: Wallet) {
  return wallet.features[StandardConnect] as
    | StandardConnectFeature[typeof StandardConnect]
    | undefined;
}

function getDisconnectFeature(wallet: Wallet) {
  return wallet.features[StandardDisconnect] as
    | StandardDisconnectFeature[typeof StandardDisconnect]
    | undefined;
}

function getSignTransactionFeature(wallet: Wallet) {
  return wallet.features[SolanaSignTransaction] as
    | SolanaSignTransactionFeature[typeof SolanaSignTransaction]
    | undefined;
}

function supportsWalletConnect(wallet: Wallet): boolean {
  return !!getConnectFeature(wallet);
}

function supportsWalletSigning(wallet: Wallet): boolean {
  return !!getSignTransactionFeature(wallet);
}

function listLegacyWalletOptions(): WalletOption[] {
  if (typeof window === "undefined") return [];

  const globalWindow = window as WalletWindow;
  const candidates: Array<{ id: string; name: string; provider?: LegacySolanaProvider }> = [
    {
      id: "legacy:swig",
      name: "Swig",
      provider:
        globalWindow.swig && "solana" in globalWindow.swig
          ? globalWindow.swig.solana
          : (globalWindow.swig as LegacySolanaProvider | undefined),
    },
    {
      id: "legacy:phantom",
      name: "Phantom",
      provider: globalWindow.phantom?.solana ?? (globalWindow.solana?.isPhantom ? globalWindow.solana : undefined),
    },
    {
      id: "legacy:backpack",
      name: "Backpack",
      provider: globalWindow.backpack?.solana ?? (globalWindow.solana?.isBackpack ? globalWindow.solana : undefined),
    },
    {
      id: "legacy:solflare",
      name: "Solflare",
      provider: globalWindow.solflare ?? (globalWindow.solana?.isSolflare ? globalWindow.solana : undefined),
    },
    {
      id: "legacy:coinbase-solana",
      name: "Coinbase Solana",
      provider: globalWindow.coinbaseSolana,
    },
    {
      id: "legacy:window-solana",
      name: globalWindow.solana?.isSwig ? "Swig" : "Injected Solana",
      provider: globalWindow.solana,
    },
  ];

  const seen = new Set<LegacySolanaProvider>();
  return candidates
    .filter((candidate) => {
      if (!candidate.provider?.connect || !candidate.provider.signTransaction) return false;
      if (seen.has(candidate.provider)) return false;
      seen.add(candidate.provider);
      return true;
    })
    .map((candidate) => ({
      id: candidate.id,
      kind: "legacy",
      name: candidate.name,
      provider: candidate.provider,
    }));
}

function listWalletOptions(): WalletOption[] {
  const standardWallets = getWallets()
    .get()
    .filter((wallet) => supportsWalletConnect(wallet) && supportsWalletSigning(wallet))
    .map((wallet) => ({
      id: `standard:${wallet.name}`,
      kind: "standard" as const,
      name: wallet.name,
      wallet,
    }));

  return [...standardWallets, ...listLegacyWalletOptions()];
}

function pickPreferredWalletId(options: WalletOption[], currentWalletId: string): string {
  if (currentWalletId && options.some((option) => option.id === currentWalletId)) return currentWalletId;
  const swigWallet = options.find((option) => option.name.toLowerCase().includes("swig"));
  return swigWallet?.id ?? options[0]?.id ?? "";
}

async function requestApi(
  path: string,
  init: RequestInit = {},
  apiKey?: string,
): Promise<ApiResponse> {
  const headers = new Headers(init.headers ?? {});
  if (!headers.has("Content-Type") && init.body) headers.set("Content-Type", "application/json");
  if (apiKey?.trim()) headers.set("x-api-key", apiKey.trim());

  const response = await fetch(`/api${path}`, { ...init, headers });
  const rawText = await response.text();
  let data: unknown = rawText;
  try {
    data = rawText ? JSON.parse(rawText) : {};
  } catch {
    data = rawText;
  }
  const resHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    resHeaders[key] = value;
  });
  return { ok: response.ok, status: response.status, data, headers: resHeaders, rawText };
}

async function buildUnsignedDevnetTxBase64(): Promise<string> {
  const conn = new Connection(DEVNET_RPC, "confirmed");
  const { blockhash } = await conn.getLatestBlockhash();
  const payer = Keypair.generate();
  const recipient = Keypair.generate();
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: [
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: recipient.publicKey,
        lamports: 5000,
      }),
    ],
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  return toBase64(tx.serialize());
}

async function fetchBase64FromSignature(signature: string, rpcUrl = DEVNET_RPC): Promise<string> {
  const rpcRes = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getTransaction",
      params: [signature, { encoding: "base64", maxSupportedTransactionVersion: 0 }],
    }),
  });
  const payload = (await rpcRes.json()) as {
    result?: { transaction?: string | [string, string] } | null;
    error?: { message?: string };
  };
  if (payload.error) throw new Error(payload.error.message || "RPC getTransaction failed");
  if (!payload.result?.transaction) {
    throw new Error("Bu signature icin transaction bulunamadi.");
  }
  if (Array.isArray(payload.result.transaction)) return payload.result.transaction[0];
  return payload.result.transaction;
}

async function createRealDevnetTransferScenario(): Promise<{
  signature: string;
  base64: string;
  payer: string;
  recipient: string;
}> {
  const conn = new Connection(DEVNET_RPC, "confirmed");
  const payer = Keypair.generate();
  const recipient = Keypair.generate();

  const airdropSig = await conn.requestAirdrop(payer.publicKey, 1_000_000_000);
  await conn.confirmTransaction(airdropSig, "confirmed");

  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: [
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: recipient.publicKey,
        lamports: 50_000_000,
      }),
    ],
  }).compileToV0Message();

  const tx = new VersionedTransaction(message);
  tx.sign([payer]);
  const signature = await conn.sendTransaction(tx, { skipPreflight: false });
  await conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");

  const base64 = await fetchBase64FromSignature(signature, DEVNET_RPC);
  return {
    signature,
    base64,
    payer: payer.publicKey.toBase58(),
    recipient: recipient.publicKey.toBase58(),
  };
}

// UI Components
function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`bg-[#12121A] border border-[#1E1E2E] rounded-xl p-5 ${className}`}>
      {children}
    </div>
  );
}

function Button({
  children,
  onClick,
  disabled,
  variant = "primary",
  className = "",
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: "primary" | "secondary";
  className?: string;
}) {
  const base = "px-5 py-2.5 rounded-lg text-sm font-medium transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed";
  const variants = {
    primary: "bg-[#8B5CF6] hover:bg-[#7C3AED] text-white",
    secondary: "bg-transparent border border-[#1E1E2E] text-[#E8E8ED] hover:bg-[#1A1A28]",
  };
  return (
    <button onClick={onClick} disabled={disabled} className={`${base} ${variants[variant]} ${className}`}>
      {children}
    </button>
  );
}

function Input({
  value,
  onChange,
  placeholder,
  type = "text",
  className = "",
}: {
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  placeholder?: string;
  type?: string;
  className?: string;
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      className={`w-full bg-[#0A0A0F] border border-[#1E1E2E] rounded-lg px-4 py-2.5 text-sm text-[#E8E8ED] placeholder-[#6B6B80] focus:border-[#8B5CF6] focus:ring-1 focus:ring-[#8B5CF6] outline-none transition-all duration-150 ${className}`}
    />
  );
}

function Select({
  value,
  onChange,
  children,
  className = "",
}: {
  value: string;
  onChange: (e: React.ChangeEvent<HTMLSelectElement>) => void;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <select
      value={value}
      onChange={onChange}
      className={`w-full bg-[#0A0A0F] border border-[#1E1E2E] rounded-lg px-4 py-2.5 text-sm text-[#E8E8ED] focus:border-[#8B5CF6] focus:ring-1 focus:ring-[#8B5CF6] outline-none transition-all duration-150 ${className}`}
    >
      {children}
    </select>
  );
}

function Textarea({
  value,
  onChange,
  placeholder,
  rows = 5,
  readOnly = false,
  className = "",
}: {
  value: string;
  onChange?: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  placeholder?: string;
  rows?: number;
  readOnly?: boolean;
  className?: string;
}) {
  return (
    <textarea
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      rows={rows}
      readOnly={readOnly}
      className={`w-full bg-[#0A0A0F] border border-[#1E1E2E] rounded-lg px-4 py-2.5 text-sm text-[#E8E8ED] placeholder-[#6B6B80] focus:border-[#8B5CF6] focus:ring-1 focus:ring-[#8B5CF6] outline-none transition-all duration-150 resize-y font-mono ${className}`}
    />
  );
}

function Label({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <label className={`block text-xs font-medium text-[#6B6B80] uppercase tracking-wider mb-2 ${className}`}>
      {children}
    </label>
  );
}

function InfoCallout({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-[#8B5CF6]/8 border border-[#8B5CF6]/20 rounded-lg p-4 text-sm text-[#E8E8ED]">
      {children}
    </div>
  );
}

function WarningCallout({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-[#F59E0B]/8 border border-[#F59E0B]/20 rounded-lg p-4 text-sm text-[#E8E8ED]">
      {children}
    </div>
  );
}

function JsonOutput({ children, className = "" }: { children: string; className?: string }) {
  return (
    <pre className={`bg-[#0A0A0F] border border-[#1E1E2E] rounded-lg p-4 font-mono text-xs text-[#A78BFA] overflow-auto max-h-[400px] whitespace-pre-wrap break-words ${className}`}>
      {children}
    </pre>
  );
}

function StatusBadge({ done }: { done: boolean }) {
  if (done) {
    return (
      <span className="flex items-center gap-1.5 text-xs">
        <span className="w-1.5 h-1.5 rounded-full bg-[#22C55E]" />
        <span className="text-[#22C55E]">Tamam</span>
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1.5 text-xs">
      <span className="w-1.5 h-1.5 rounded-full bg-[#6B6B80]" />
      <span className="text-[#6B6B80]">Bekliyor</span>
    </span>
  );
}

function ApiBox({ title, response }: { title: string; response: ApiResponse | null }) {
  return (
    <Card>
      <h3 className="text-sm font-semibold text-[#E8E8ED] mb-3">{title}</h3>
      {response ? (
        <>
          <p className={`text-xs font-semibold mb-2 ${response.ok ? "text-[#22C55E]" : "text-[#EF4444]"}`}>
            HTTP {response.status} {response.ok ? "OK" : "HATA"}
          </p>
          <JsonOutput>{JSON.stringify(response.data, null, 2)}</JsonOutput>
          <details className="mt-3">
            <summary className="text-xs text-[#6B6B80] cursor-pointer hover:text-[#E8E8ED]">Header detaylari</summary>
            <JsonOutput className="mt-2">{pretty(response.headers)}</JsonOutput>
          </details>
        </>
      ) : (
        <p className="text-sm text-[#6B6B80]">Henuz istek gonderilmedi.</p>
      )}
    </Card>
  );
}

export default function TestLabApp() {
  const [activePage, setActivePage] = useState<PageId>("welcome");
  const [cluster, setCluster] = useState<Cluster>("devnet");
  const [apiKey, setApiKey] = useState("");
  const [txBase64, setTxBase64] = useState("");
  const [txSignature, setTxSignature] = useState("");
  const [scenarioMeta, setScenarioMeta] = useState<ScenarioMeta>({ type: "", note: "" });
  const [policyJson, setPolicyJson] = useState("{}");
  const [slotInput, setSlotInput] = useState("");
  const [batchInput, setBatchInput] = useState("");
  const [mcpTool, setMcpTool] = useState("deltag_health");
  const [mcpArgs, setMcpArgs] = useState("{}");
  const [walletOptions, setWalletOptions] = useState<WalletOption[]>([]);
  const [selectedWalletId, setSelectedWalletId] = useState("");
  const [connectedWallet, setConnectedWallet] = useState<ConnectedWalletState | null>(null);
  const [walletBalanceLamports, setWalletBalanceLamports] = useState<number | null>(null);
  const [walletRecipient, setWalletRecipient] = useState(() => Keypair.generate().publicKey.toBase58());
  const [walletLamports, setWalletLamports] = useState("5000");
  const [isBusy, setIsBusy] = useState<string | null>(null);

  const [analyzeRes, setAnalyzeRes] = useState<ApiResponse | null>(null);
  const [batchRes, setBatchRes] = useState<ApiResponse | null>(null);
  const [replayRes, setReplayRes] = useState<ApiResponse | null>(null);
  const [auditRecentRes, setAuditRecentRes] = useState<ApiResponse | null>(null);
  const [auditAggregateRes, setAuditAggregateRes] = useState<ApiResponse | null>(null);
  const [x402ProbeRes, setX402ProbeRes] = useState<ApiResponse | null>(null);
  const [mcpToolsRes, setMcpToolsRes] = useState<ApiResponse | null>(null);
  const [mcpCallRes, setMcpCallRes] = useState<ApiResponse | null>(null);
  const [streamEvents, setStreamEvents] = useState<string[]>([]);
  const [healthRes, setHealthRes] = useState<ApiResponse | null>(null);
  const [readyRes, setReadyRes] = useState<ApiResponse | null>(null);
  const [error, setError] = useState<string>("");

  const effectiveSelectedWalletId = useMemo(
    () => pickPreferredWalletId(walletOptions, selectedWalletId),
    [walletOptions, selectedWalletId],
  );
  const selectedWalletOption = useMemo(
    () => walletOptions.find((option) => option.id === effectiveSelectedWalletId) ?? null,
    [effectiveSelectedWalletId, walletOptions],
  );

  useEffect(() => {
    const syncWalletOptions = () => {
      setWalletOptions(listWalletOptions());
    };

    const walletRegistry = getWallets();
    syncWalletOptions();

    const offRegister = walletRegistry.on("register", () => syncWalletOptions());
    const offUnregister = walletRegistry.on("unregister", () => syncWalletOptions());
    const intervalId = window.setInterval(syncWalletOptions, 2500);

    return () => {
      offRegister();
      offUnregister();
      window.clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    async function refreshBalanceSilently() {
      if (!connectedWallet?.address) {
        setWalletBalanceLamports(null);
        return;
      }
      try {
        const conn = new Connection(getRpcUrl(cluster), "confirmed");
        const lamports = await conn.getBalance(new PublicKey(connectedWallet.address), "confirmed");
        setWalletBalanceLamports(lamports);
      } catch {
        /* ignore silent refresh failures */
      }
    }

    void refreshBalanceSilently();
  }, [cluster, connectedWallet?.address]);

  const analyzeBody = (() => {
    let policy: Record<string, unknown> | undefined = undefined;
    const parsed = safeJsonParseObject(policyJson || "{}");
    if (parsed === null) return null;
    if (Object.keys(parsed).length > 0) policy = parsed;
    if (!txBase64.trim()) return null;
    return {
      cluster,
      transactionBase64: txBase64.trim(),
      policy,
      ...(connectedWallet?.address ? { userWallet: connectedWallet.address } : {}),
    };
  })();

  async function runWithBusy<T>(name: string, fn: () => Promise<T>) {
    setIsBusy(name);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsBusy(null);
    }
  }

  async function refreshConnectedWalletBalance() {
    if (!connectedWallet?.address) throw new Error("Once wallet bagla.");
    const conn = new Connection(getRpcUrl(cluster), "confirmed");
    const lamports = await conn.getBalance(new PublicKey(connectedWallet.address), "confirmed");
    setWalletBalanceLamports(lamports);
  }

  function requireConnectedWallet(): ConnectedWalletState {
    if (!connectedWallet) throw new Error("Once bir wallet bagla.");
    return connectedWallet;
  }

  function parseWalletLamports(): number {
    const lamports = Number(walletLamports.trim());
    if (!Number.isInteger(lamports) || lamports <= 0) {
      throw new Error("Lamports pozitif bir tam sayi olmali.");
    }
    return lamports;
  }

  function parseWalletRecipient(): PublicKey {
    try {
      return new PublicKey(walletRecipient.trim());
    } catch {
      throw new Error("Recipient wallet adresi gecersiz.");
    }
  }

  async function buildWalletTransferTx() {
    const walletState = requireConnectedWallet();
    const lamports = parseWalletLamports();
    const recipient = parseWalletRecipient();
    const conn = new Connection(getRpcUrl(cluster), "confirmed");
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
    const message = new TransactionMessage({
      payerKey: new PublicKey(walletState.address),
      recentBlockhash: blockhash,
      instructions: [
        SystemProgram.transfer({
          fromPubkey: new PublicKey(walletState.address),
          toPubkey: recipient,
          lamports,
        }),
      ],
    }).compileToV0Message();

    return {
      conn,
      lamports,
      recipient: recipient.toBase58(),
      blockhash,
      lastValidBlockHeight,
      tx: new VersionedTransaction(message),
      walletState,
    };
  }

  async function signWithConnectedWallet(transaction: VersionedTransaction): Promise<VersionedTransaction> {
    const walletState = requireConnectedWallet();

    if (walletState.kind === "standard") {
      const wallet = walletState.wallet;
      const account = walletState.account;
      if (!wallet || !account) {
        throw new Error("Standard wallet account bilgisi eksik.");
      }
      const signFeature = getSignTransactionFeature(wallet);
      if (!signFeature) {
        throw new Error(`${walletState.walletName} signTransaction desteklemiyor.`);
      }
      const [output] = await signFeature.signTransaction({
        account,
        transaction: transaction.serialize(),
      });
      if (!output) throw new Error("Wallet imzali transaction dondurmedi.");
      return VersionedTransaction.deserialize(output.signedTransaction);
    }

    if (!walletState.provider) throw new Error("Injected wallet provider bulunamadi.");
    return walletState.provider.signTransaction(transaction);
  }

  async function onRefreshWallets() {
    await runWithBusy("wallet-refresh", async () => {
      setWalletOptions(listWalletOptions());
    });
  }

  async function onConnectWallet() {
    await runWithBusy("wallet-connect", async () => {
      const option = selectedWalletOption;
      if (!option) throw new Error("Baglanabilir wallet bulunamadi. Swig veya baska bir Solana wallet acik degil.");

      if (option.kind === "standard") {
        const wallet = option.wallet;
        if (!wallet) throw new Error("Standard wallet nesnesi eksik.");
        const connectFeature = getConnectFeature(wallet);
        if (!connectFeature) throw new Error(`${wallet.name} connect desteklemiyor.`);
        const result = await connectFeature.connect();
        const account = result.accounts[0] ?? wallet.accounts[0];
        if (!account) throw new Error("Wallet baglandi ama hesap bilgisi gelmedi.");
        setConnectedWallet({
          walletId: option.id,
          walletName: wallet.name,
          kind: "standard",
          address: account.address,
          account,
          wallet,
        });
      } else {
        const provider = option.provider;
        if (!provider) throw new Error("Injected wallet provider bulunamadi.");
        const result = await provider.connect();
        const address = result?.publicKey?.toBase58?.() ?? provider.publicKey?.toBase58?.();
        if (!address) throw new Error("Wallet baglandi ama public key okunamadi.");
        setConnectedWallet({
          walletId: option.id,
          walletName: option.name,
          kind: "legacy",
          address,
          provider,
        });
      }

      setSelectedWalletId(option.id);
    });
  }

  async function onDisconnectWallet() {
    await runWithBusy("wallet-disconnect", async () => {
      if (!connectedWallet) return;

      if (connectedWallet.kind === "standard" && connectedWallet.wallet) {
        const disconnectFeature = getDisconnectFeature(connectedWallet.wallet);
        await disconnectFeature?.disconnect();
      } else {
        await connectedWallet.provider?.disconnect?.();
      }

      setConnectedWallet(null);
      setWalletBalanceLamports(null);
    });
  }

  async function onRequestWalletAirdrop() {
    await runWithBusy("wallet-airdrop", async () => {
      const walletState = requireConnectedWallet();
      if (cluster !== "devnet") {
        throw new Error("Airdrop butonu sadece devnet icin acik.");
      }
      const conn = new Connection(getRpcUrl(cluster), "confirmed");
      const signature = await conn.requestAirdrop(new PublicKey(walletState.address), 1_000_000_000);
      await conn.confirmTransaction(signature, "confirmed");
      await refreshConnectedWalletBalance();
      setTxSignature(signature);
    });
  }

  async function onRefreshWalletBalance() {
    await runWithBusy("wallet-balance", async () => {
      await refreshConnectedWalletBalance();
    });
  }

  async function onGenerateWalletRecipient() {
    await runWithBusy("wallet-recipient", async () => {
      setWalletRecipient(Keypair.generate().publicKey.toBase58());
    });
  }

  async function onPrepareWalletSignedTx() {
    await runWithBusy("wallet-sign", async () => {
      const { tx, lamports, recipient, walletState } = await buildWalletTransferTx();
      const signedTx = await signWithConnectedWallet(tx);
      const base64 = toBase64(signedTx.serialize());

      setTxBase64(base64);
      setBatchInput(base64);
      setScenarioMeta({
        type: "wallet-signed",
        note: "Bagli wallet ile imzali test tx hazirlandi. Gonderilmedi; analyze icin hazir.",
        payer: walletState.address,
        recipient,
        walletName: walletState.walletName,
        lamports,
      });
    });
  }

  async function onSendWalletTestTx() {
    await runWithBusy("wallet-send", async () => {
      const { conn, tx, blockhash, lastValidBlockHeight, lamports, recipient, walletState } =
        await buildWalletTransferTx();

      if (cluster !== "devnet") {
        throw new Error("Gercek gonderim butonu sadece devnet icin acik.");
      }

      const signedTx = await signWithConnectedWallet(tx);
      const signature = await conn.sendRawTransaction(signedTx.serialize(), { skipPreflight: false });
      await conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");

      const base64 = await fetchBase64FromSignature(signature, getRpcUrl(cluster));
      setTxSignature(signature);
      setTxBase64(base64);
      setBatchInput(base64);
      setScenarioMeta({
        type: "wallet-sent",
        note: "Bagli wallet ile devnet transferi gonderildi ve geri okunup TestLab'e yerlestirildi.",
        signature,
        payer: walletState.address,
        recipient,
        walletName: walletState.walletName,
        lamports,
      });
      await refreshConnectedWalletBalance();
    });
  }

  async function onGenerateSampleTx() {
    await runWithBusy("sample-tx", async () => {
      const base64 = await buildUnsignedDevnetTxBase64();
      setTxBase64(base64);
      setBatchInput(base64);
      setScenarioMeta({
        type: "unsigned",
        note: "Imzasiz test transaction olusturuldu. Hizli demo icin iyidir.",
      });
    });
  }

  async function onLoadFromSignature() {
    if (!txSignature.trim()) {
      setError("Once devnet transaction signature gir.");
      return;
    }
    await runWithBusy("signature", async () => {
      const base64 = await fetchBase64FromSignature(txSignature.trim(), DEVNET_RPC);
      setTxBase64(base64);
      setBatchInput(base64);
      setScenarioMeta({
        type: "signature",
        note: "Devnet'te gerceklesmis bir transaction'dan base64 yuklendi.",
        signature: txSignature.trim(),
      });
    });
  }

  async function onCreateRealScenario() {
    await runWithBusy("real-devnet", async () => {
      const scenario = await createRealDevnetTransferScenario();
      setTxSignature(scenario.signature);
      setTxBase64(scenario.base64);
      setBatchInput(scenario.base64);
      setScenarioMeta({
        type: "real-devnet",
        note: "Airdrop + gercek transfer senaryosu olusturuldu.",
        signature: scenario.signature,
        payer: scenario.payer,
        recipient: scenario.recipient,
      });
    });
  }

  async function onHealthChecks() {
    await runWithBusy("health", async () => {
      const [h, r] = await Promise.all([requestApi("/health"), requestApi("/health/ready")]);
      setHealthRes(h);
      setReadyRes(r);
    });
  }

  async function onAnalyze() {
    if (!analyzeBody) {
      setError("Gecerli base64 transaction ve policy JSON gir.");
      return;
    }
    await runWithBusy("analyze", async () => {
      const response = await requestApi(
        "/v1/analyze",
        { method: "POST", body: JSON.stringify(analyzeBody) },
        apiKey,
      );
      setAnalyzeRes(response);
    });
  }

  async function onX402Probe() {
    if (!analyzeBody) {
      setError("x402 testi icin once transaction hazirla.");
      return;
    }
    await runWithBusy("x402", async () => {
      const response = await requestApi("/v1/analyze", {
        method: "POST",
        body: JSON.stringify(analyzeBody),
      });
      setX402ProbeRes(response);
    });
  }

  async function onBatch() {
    const lines = batchInput
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length === 0) {
      setError("Batch icin en az bir base64 satiri olmali.");
      return;
    }
    await runWithBusy("batch", async () => {
      const response = await requestApi(
        "/v1/analyze/batch",
        {
          method: "POST",
          body: JSON.stringify({
            transactions: lines.map((line) => ({
              cluster,
              transactionBase64: line,
              ...(connectedWallet?.address ? { userWallet: connectedWallet.address } : {}),
            })),
          }),
        },
        apiKey,
      );
      setBatchRes(response);
    });
  }

  async function onStream() {
    const lines = batchInput
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length === 0) {
      setError("SSE stream icin batch listesi bos olamaz.");
      return;
    }
    await runWithBusy("stream", async () => {
      setStreamEvents(["SSE stream baslatildi..."]);
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (apiKey.trim()) headers["x-api-key"] = apiKey.trim();
      const response = await fetch("/api/v1/analyze/stream", {
        method: "POST",
        headers,
        body: JSON.stringify({
          transactions: lines.map((line) => ({
            cluster,
            transactionBase64: line,
            ...(connectedWallet?.address ? { userWallet: connectedWallet.address } : {}),
          })),
        }),
      });
      if (!response.body) throw new Error("SSE stream body okunamadi.");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split("\n\n");
        buffer = chunks.pop() ?? "";
        for (const chunk of chunks) {
          const eventLine = chunk.split("\n").find((line) => line.startsWith("event: "));
          const dataLine = chunk.split("\n").find((line) => line.startsWith("data: "));
          const event = eventLine?.replace("event: ", "") ?? "message";
          const data = dataLine?.replace("data: ", "") ?? "{}";
          setStreamEvents((prev) => [...prev, `[${event}] ${data}`]);
        }
      }
      setStreamEvents((prev) => [...prev, "SSE stream tamamlandi."]);
    });
  }

  async function onReplay() {
    if (!txBase64.trim()) {
      setError("Replay icin transaction gerekli.");
      return;
    }
    await runWithBusy("replay", async () => {
      const body: Record<string, unknown> = {
        cluster,
        transactionBase64: txBase64.trim(),
      };
      if (slotInput.trim()) body.slot = Number(slotInput.trim());
      const response = await requestApi(
        "/v1/replay",
        { method: "POST", body: JSON.stringify(body) },
        apiKey,
      );
      setReplayRes(response);
    });
  }

  async function onAudit() {
    await runWithBusy("audit", async () => {
      const [recent, aggregate] = await Promise.all([
        requestApi("/v1/audit/recent?limit=20", {}, apiKey),
        requestApi("/v1/audit/aggregate", {}, apiKey),
      ]);
      setAuditRecentRes(recent);
      setAuditAggregateRes(aggregate);
    });
  }

  async function onMcpTools() {
    await runWithBusy("mcp-tools", async () => {
      const response = await requestApi("/mcp/tools", {}, apiKey);
      setMcpToolsRes(response);
    });
  }

  async function onMcpCall() {
    const parsedArgs = safeJsonParseObject(mcpArgs || "{}");
    if (parsedArgs === null) {
      setError("MCP args JSON parse edilemedi.");
      return;
    }
    await runWithBusy("mcp-call", async () => {
      const response = await requestApi(
        "/mcp/call",
        { method: "POST", body: JSON.stringify({ tool: mcpTool, arguments: parsedArgs }) },
        apiKey,
      );
      setMcpCallRes(response);
    });
  }

  const decisionCard = analyzeRes?.data as
    | { safe?: boolean; reasons?: string[]; riskFindings?: Array<{ code?: string; severity?: string }> }
    | undefined;

  const pages: Array<{
    id: PageId;
    title: string;
    hint: string;
    done: boolean;
  }> = [
    { id: "welcome", title: "0. Baslangic", hint: "Neyi test ediyoruz?", done: true },
    {
      id: "setup",
      title: "1. Ortam Kontrol",
      hint: "API ve saglik",
      done: !!healthRes && !!readyRes,
    },
    {
      id: "scenario",
      title: "2. Senaryo Uret",
      hint: "Gercek tx / wallet tx",
      done: !!txBase64,
    },
    {
      id: "analyze",
      title: "3. Analyze",
      hint: "Ana karar motoru",
      done: !!analyzeRes,
    },
    {
      id: "batch",
      title: "4. Batch",
      hint: "Toplu test",
      done: !!batchRes,
    },
    {
      id: "stream",
      title: "5. SSE Stream",
      hint: "Canli event akisi",
      done: streamEvents.length > 0,
    },
    {
      id: "replay",
      title: "6. Replay",
      hint: "Ayni tx'i tekrar oynat",
      done: !!replayRes,
    },
    {
      id: "audit",
      title: "7. Audit",
      hint: "Kayit ve aggregate",
      done: !!auditRecentRes || !!auditAggregateRes,
    },
    {
      id: "mcp",
      title: "8. MCP",
      hint: "Agent araci testi",
      done: !!mcpToolsRes || !!mcpCallRes,
    },
    {
      id: "x402",
      title: "9. x402",
      hint: "Odeme kapisi testi",
      done: !!x402ProbeRes,
    },
  ];

  function renderPage() {
    if (activePage === "welcome") {
      return (
        <div className="space-y-6">
          <div>
            <h1 className="text-2xl font-semibold text-[#E8E8ED]">Blackthorn Test Akademi</h1>
            <p className="text-sm text-[#6B6B80] mt-2">
              Bu ekran bir test panelinden cok, adim adim egitimli bir laboratuvar. Yazilim bilmeyen
              biri bile soldaki adimlari sirayla ilerleyerek &quot;normalde ne olur, Blackthorn nasil fark
              yaratir&quot; sorusunu gorebilir.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Card>
              <h3 className="text-sm font-semibold text-[#E8E8ED] mb-2">Normalde</h3>
              <p className="text-sm text-[#6B6B80]">
                Kullanici genelde &quot;Approve&quot; tusuna basar. Arka planda ne risk oldugu net
                gosterilmez. Programlar, CPI zinciri, policy etkisi anlasilmaz.
              </p>
            </Card>
            <Card>
              <h3 className="text-sm font-semibold text-[#E8E8ED] mb-2">Blackthorn ile</h3>
              <p className="text-sm text-[#6B6B80]">
                Transaction imzalanmadan once simule edilir. Risk bulgulari, bakiye degisimleri,
                policy kurallari ve karar nedeni acik sekilde raporlanir.
              </p>
            </Card>
          </div>

          <InfoCallout>
            <strong>Baslamadan once:</strong> Soldan &quot;1. Ortam Kontrol&quot; adimina git. Sonra &quot;2. Senaryo Uret&quot; sayfasinda tx verisini hazirla. Kalan tum testleri sirayla calistir.
          </InfoCallout>
        </div>
      );
    }

    if (activePage === "setup") {
      return (
        <div className="space-y-6">
          <div>
            <h1 className="text-2xl font-semibold text-[#E8E8ED]">Ortam Kontrol</h1>
            <p className="text-sm text-[#6B6B80] mt-2">
              Burada sistem ayakta mi diye bakiyoruz. Bu adim fail olursa diger testlerin sonucu
              guvenilir olmaz.
            </p>
          </div>

          <WarningCallout>
            <strong>Kullanicidan beklenen:</strong> Sadece cluster secimi ve (varsa) API key. Yazilim bilgisi gerekmez.
          </WarningCallout>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>Cluster</Label>
              <Select value={cluster} onChange={(e) => setCluster(e.target.value as Cluster)}>
                {CLUSTERS.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </Select>
            </div>
            <div>
              <Label>API Key (opsiyonel)</Label>
              <Input
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="Yoksa bos birakabilirsin"
              />
            </div>
          </div>

          <div>
            <Button onClick={onHealthChecks} disabled={!!isBusy}>
              {isBusy === "health" ? "Calisiyor..." : "Health + Ready Testini Calistir"}
            </Button>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <ApiBox title="/health sonucu" response={healthRes} />
            <ApiBox title="/health/ready sonucu" response={readyRes} />
          </div>
        </div>
      );
    }

    if (activePage === "scenario") {
      return (
        <div className="space-y-6">
          <div>
            <h1 className="text-2xl font-semibold text-[#E8E8ED]">Senaryo Olusturma</h1>
            <p className="text-sm text-[#6B6B80] mt-2">
              Bu sayfa sadece rastgele tx uretmiyor; istersen bagli wallet ile gercek test transferi hazirlayip analyze&apos;a da sokabiliyorsun.
            </p>
          </div>

          {/* Wallet Connection Section */}
          <Card>
            <div className="flex items-start justify-between gap-4 mb-4">
              <div>
                <h3 className="text-sm font-semibold text-[#E8E8ED] mb-1">Wallet Baglantisi</h3>
                <p className="text-xs text-[#6B6B80]">Wallet Standard destekleyen cuzdanlari otomatik bulur.</p>
              </div>
              <span className={`px-3 py-1.5 rounded-full text-xs font-medium ${
                connectedWallet 
                  ? "bg-[#22C55E]/10 border border-[#22C55E]/30 text-[#22C55E]" 
                  : "bg-[#6B6B80]/10 border border-[#6B6B80]/30 text-[#6B6B80]"
              }`}>
                {connectedWallet ? `Bagli: ${connectedWallet.walletName.slice(0, 4)}...` : "Wallet bagli degil"}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-4 mb-4">
              <div>
                <Label>Bulunan wallet</Label>
                <Select
                  value={effectiveSelectedWalletId}
                  onChange={(e) => setSelectedWalletId(e.target.value)}
                >
                  {walletOptions.length === 0 ? (
                    <option value="">Wallet bulunamadi</option>
                  ) : (
                    walletOptions.map((wallet) => (
                      <option key={wallet.id} value={wallet.id}>{wallet.name}</option>
                    ))
                  )}
                </Select>
              </div>
              <div className="bg-[#0A0A0F] border border-[#1E1E2E] rounded-lg p-3">
                <p className="text-sm font-medium text-[#E8E8ED]">{connectedWallet?.walletName ?? "Bagli wallet yok"}</p>
                <p className="text-xs text-[#6B6B80] break-all mt-1">{connectedWallet?.address ?? "Wallet secip baglanabilirsin."}</p>
                <p className="text-xs text-[#6B6B80] mt-1">Bakiye: {formatSol(walletBalanceLamports)}</p>
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={onConnectWallet} disabled={!!isBusy || walletOptions.length === 0}>
                Wallet Bagla
              </Button>
              <Button variant="secondary" onClick={onDisconnectWallet} disabled={!!isBusy || !connectedWallet}>
                Wallet Baglantisini Kes
              </Button>
              <Button variant="secondary" onClick={onRefreshWallets} disabled={!!isBusy}>
                Wallet Listesini Yenile
              </Button>
              <Button variant="secondary" onClick={onRefreshWalletBalance} disabled={!!isBusy || !connectedWallet}>
                Bakiye Yenile
              </Button>
              <Button variant="secondary" onClick={onRequestWalletAirdrop} disabled={!!isBusy || !connectedWallet || cluster !== "devnet"}>
                Devnet Airdrop (1 SOL)
              </Button>
            </div>
          </Card>

          {/* Transfer Settings */}
          <Card>
            <h3 className="text-sm font-semibold text-[#E8E8ED] mb-4">Transfer Ayarlari</h3>
            <div className="grid grid-cols-2 gap-4 mb-4">
              <div>
                <Label>Recipient adresi</Label>
                <Input
                  value={walletRecipient}
                  onChange={(e) => setWalletRecipient(e.target.value)}
                  placeholder="Devnet recipient public key"
                />
              </div>
              <div>
                <Label>Transfer miktari (lamports)</Label>
                <Input
                  value={walletLamports}
                  onChange={(e) => setWalletLamports(e.target.value)}
                  placeholder="5000"
                />
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button onClick={onGenerateWalletRecipient} disabled={!!isBusy}>
                Yeni Recipient Uret
              </Button>
              <Button variant="secondary" onClick={onPrepareWalletSignedTx} disabled={!!isBusy || !connectedWallet}>
                Wallet ile Sign Et ve Analyze&apos;a Yukle
              </Button>
              <Button variant="secondary" onClick={onSendWalletTestTx} disabled={!!isBusy || !connectedWallet || cluster !== "devnet"}>
                Wallet ile Sign + Send (Devnet)
              </Button>
            </div>
          </Card>

          <InfoCallout>
            <strong>Wallet butonlari:</strong> Ilki imzali tx&apos;i sadece analyze icin hazirlar. Ikincisi ise gercek devnet transferini yollar ve signature/base64&apos;i otomatik doldurur.
          </InfoCallout>

          {/* Quick Generation */}
          <Card>
            <h3 className="text-sm font-semibold text-[#E8E8ED] mb-4">Hizli Uretim</h3>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={onCreateRealScenario} disabled={!!isBusy}>
                {isBusy === "real-devnet" ? "Calisiyor..." : "Gercek Devnet Transfer Senaryosu Olustur"}
              </Button>
              <Button variant="secondary" onClick={onGenerateSampleTx} disabled={!!isBusy}>
                {isBusy === "sample-tx" ? "Calisiyor..." : "Hizli Demo Tx Uret (Imzasiz)"}
              </Button>
            </div>
          </Card>

          {/* Load from Signature */}
          <Card>
            <h3 className="text-sm font-semibold text-[#E8E8ED] mb-4">Signature&apos;dan Yukle</h3>
            <div className="grid grid-cols-[1fr_auto] gap-4 items-end">
              <div>
                <Label>Varsa Devnet Signature</Label>
                <Input
                  value={txSignature}
                  onChange={(e) => setTxSignature(e.target.value)}
                  placeholder="Ornek: 5Q..."
                />
              </div>
              <Button onClick={onLoadFromSignature} disabled={!!isBusy}>
                Signature&apos;dan Base64 Getir
              </Button>
            </div>
          </Card>

          {/* Output */}
          <div>
            <Label>Hazirlanan Transaction Base64</Label>
            <Textarea
              rows={8}
              value={txBase64}
              onChange={(e) => setTxBase64(e.target.value)}
              placeholder="Bu alan tum sonraki testlerde kullanilir."
            />
          </div>

          {scenarioMeta.type && (
            <Card>
              <h3 className="text-sm font-semibold text-[#E8E8ED] mb-2">Senaryo Ozeti</h3>
              <JsonOutput>{pretty(scenarioMeta)}</JsonOutput>
            </Card>
          )}
        </div>
      );
    }

    if (activePage === "analyze") {
      return (
        <div className="space-y-6">
          <div>
            <h1 className="text-2xl font-semibold text-[#E8E8ED]">Analyze (Ana Motor)</h1>
            <p className="text-sm text-[#6B6B80] mt-2">
              Bu adim projenin kalbi. Bir transaction guvenli mi, degil mi? Neden? Hangi bulgularla? Bu sayfada cevap gorursun.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Card>
              <h3 className="text-sm font-semibold text-[#E8E8ED] mb-2">Normalde</h3>
              <p className="text-sm text-[#6B6B80]">
                Bir cogu uygulama sadece &quot;onayla&quot; der, teknik detay aciklamaz.
              </p>
            </Card>
            <Card>
              <h3 className="text-sm font-semibold text-[#E8E8ED] mb-2">Blackthorn Farki</h3>
              <p className="text-sm text-[#6B6B80]">
                Risk findings, reason listesi, semantic ozet, ve policy sonucu birlikte gelir.
              </p>
            </Card>
          </div>

          {connectedWallet && (
            <InfoCallout>
              <strong>User wallet context:</strong> Analyze ve batch isteklerine otomatik olarak <code className="font-mono text-[#A78BFA]">{connectedWallet.address}</code> eklenecek.
            </InfoCallout>
          )}

          <div>
            <Label>Policy JSON (opsiyonel)</Label>
            <Textarea rows={5} value={policyJson} onChange={(e) => setPolicyJson(e.target.value)} />
          </div>

          <div>
            <Button onClick={onAnalyze} disabled={!!isBusy}>
              {isBusy === "analyze" ? "Calisiyor..." : "Analyze Testini Calistir"}
            </Button>
          </div>

          {decisionCard && (
            <div className={`rounded-lg p-4 border ${
              decisionCard.safe 
                ? "bg-[#22C55E]/10 border-[#22C55E]/30" 
                : "bg-[#EF4444]/10 border-[#EF4444]/30"
            }`}>
              <strong className={decisionCard.safe ? "text-[#22C55E]" : "text-[#EF4444]"}>
                {decisionCard.safe ? "SAFE / ALLOW" : "RISKLI / BLOCK"}
              </strong>
              <p className="text-sm text-[#E8E8ED] mt-2">
                {decisionCard.safe
                  ? "Bu senaryoda karar guvenli gorunuyor."
                  : "Bu senaryoda risk tespit edildi. Asagidaki nedenler aciklamadir."}
              </p>
              {decisionCard.reasons && decisionCard.reasons.length > 0 && (
                <ul className="list-disc list-inside text-sm text-[#6B6B80] mt-2">
                  {decisionCard.reasons.slice(0, 6).map((reason, idx) => (
                    <li key={`${reason}-${idx}`}>{reason}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <ApiBox title="Analyze JSON sonucu" response={analyzeRes} />
        </div>
      );
    }

    if (activePage === "batch") {
      return (
        <div className="space-y-6">
          <div>
            <h1 className="text-2xl font-semibold text-[#E8E8ED]">Batch Test</h1>
            <p className="text-sm text-[#6B6B80] mt-2">
              Ayni anda birden fazla transaction test ederek sistemin tutarliligini gorursun. Gercek hayatta entegratorler bu endpointi toplu tarama icin kullanir.
            </p>
          </div>

          <div>
            <Label>Batch Listesi (her satir bir base64)</Label>
            <Textarea
              rows={8}
              value={batchInput}
              onChange={(e) => setBatchInput(e.target.value)}
              placeholder={"base64-1\nbase64-2"}
            />
          </div>

          <div>
            <Button onClick={onBatch} disabled={!!isBusy}>
              {isBusy === "batch" ? "Calisiyor..." : "Batch Testini Calistir"}
            </Button>
          </div>

          <ApiBox title="Batch JSON sonucu" response={batchRes} />
        </div>
      );
    }

    if (activePage === "stream") {
      return (
        <div className="space-y-6">
          <div>
            <h1 className="text-2xl font-semibold text-[#E8E8ED]">Stream (SSE)</h1>
            <p className="text-sm text-[#6B6B80] mt-2">
              Bu adimda sonuclarin &quot;canli event&quot; olarak akisini gorursun. Uzun batch&apos;lerde ilerleme takibi icin idealdir.
            </p>
          </div>

          <div>
            <Button onClick={onStream} disabled={!!isBusy}>
              {isBusy === "stream" ? "Calisiyor..." : "Stream Testini Baslat"}
            </Button>
          </div>

          <Card>
            <h3 className="text-sm font-semibold text-[#E8E8ED] mb-3">Canli Event Log</h3>
            <div className="bg-[#0A0A0F] border border-[#1E1E2E] rounded-lg p-4 font-mono text-xs text-[#A78BFA] overflow-auto max-h-[400px]">
              {streamEvents.length > 0 ? (
                streamEvents.map((event, idx) => (
                  <div key={idx} className="py-0.5 animate-[fadeIn_0.3s_ease-in]">{event}</div>
                ))
              ) : (
                <span className="text-[#6B6B80]">Henuz event yok.</span>
              )}
            </div>
          </Card>
        </div>
      );
    }

    if (activePage === "replay") {
      return (
        <div className="space-y-6">
          <div>
            <h1 className="text-2xl font-semibold text-[#E8E8ED]">Replay</h1>
            <p className="text-sm text-[#6B6B80] mt-2">
              Replay ayni tx&apos;i tekrar oynatarak &quot;farkli slotta ne degisir?&quot; sorusunu test eder. Bu sayfa neden-sonuc karsilastirmasi icin cok onemlidir.
            </p>
          </div>

          <div className="max-w-md">
            <Label>Replay slot (opsiyonel)</Label>
            <Input
              value={slotInput}
              onChange={(e) => setSlotInput(e.target.value)}
              placeholder="Bos birakirsan guncel slot"
            />
          </div>

          <div>
            <Button onClick={onReplay} disabled={!!isBusy}>
              {isBusy === "replay" ? "Calisiyor..." : "Replay Testini Calistir"}
            </Button>
          </div>

          <ApiBox title="Replay JSON sonucu" response={replayRes} />
        </div>
      );
    }

    if (activePage === "audit") {
      return (
        <div className="space-y-6">
          <div>
            <h1 className="text-2xl font-semibold text-[#E8E8ED]">Audit</h1>
            <p className="text-sm text-[#6B6B80] mt-2">
              Audit kayitlari, &quot;sistem neyi ne zaman kararlastirmis?&quot; sorusunu cevaplar. Kurumsal kullanicilar icin izlenebilirlik adimidir.
            </p>
          </div>

          <div>
            <Button onClick={onAudit} disabled={!!isBusy}>
              {isBusy === "audit" ? "Calisiyor..." : "Audit Testini Calistir"}
            </Button>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <ApiBox title="Recent kayitlar" response={auditRecentRes} />
            <ApiBox title="Aggregate ozet" response={auditAggregateRes} />
          </div>
        </div>
      );
    }

    if (activePage === "mcp") {
      return (
        <div className="space-y-6">
          <div>
            <h1 className="text-2xl font-semibold text-[#E8E8ED]">MCP (Agent Araclari)</h1>
            <p className="text-sm text-[#6B6B80] mt-2">
              MCP, ajan/yardimci uygulamalarin Blackthorn ile konusmasini saglar. Bu sayfada agent araclarinin endpoint testini yapiyoruz.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>MCP Tool</Label>
              <Select value={mcpTool} onChange={(e) => setMcpTool(e.target.value)}>
                <option value="deltag_health">deltag_health</option>
                <option value="deltag_list_profiles">deltag_list_profiles</option>
                <option value="deltag_analyze">deltag_analyze</option>
              </Select>
            </div>
            <div>
              <Label>MCP Arguments JSON</Label>
              <Textarea rows={5} value={mcpArgs} onChange={(e) => setMcpArgs(e.target.value)} />
            </div>
          </div>

          <div className="flex gap-2">
            <Button variant="secondary" onClick={onMcpTools} disabled={!!isBusy}>
              {isBusy === "mcp-tools" ? "Calisiyor..." : "MCP Tools Listele"}
            </Button>
            <Button onClick={onMcpCall} disabled={!!isBusy}>
              {isBusy === "mcp-call" ? "Calisiyor..." : "MCP Call Testi"}
            </Button>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <ApiBox title="MCP tools sonucu" response={mcpToolsRes} />
            <ApiBox title="MCP call sonucu" response={mcpCallRes} />
          </div>
        </div>
      );
    }

    // x402 page (default)
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold text-[#E8E8ED]">x402 (Odeme Kapisi)</h1>
          <p className="text-sm text-[#6B6B80] mt-2">
            x402, API cagrisini odeme ile koruyan bir modeldir. Bu testte API key olmadan cagirip sistemin 402 dondugunu goruruz. Boylece odeme kapisi aktif mi anlarsin.
          </p>
        </div>

        <InfoCallout>
          <strong>Beklenen sonuc:</strong> x402 aciksa HTTP 402 ve payment-required header gelir. API key ile cagirdiginda ise normal endpoint akisi gorursun.
        </InfoCallout>

        <div>
          <Button onClick={onX402Probe} disabled={!!isBusy}>
            {isBusy === "x402" ? "Calisiyor..." : "x402 Probe Testini Calistir (API key'siz)"}
          </Button>
        </div>

        <ApiBox title="x402 probe sonucu" response={x402ProbeRes} />
      </div>
    );
  }

  return (
    <div className="min-h-screen flex">
      {/* Sidebar */}
      <aside className="w-[260px] flex-shrink-0 bg-[#12121A] border-r border-[#1E1E2E] flex flex-col h-screen sticky top-0">
        {/* Logo */}
        <div className="px-4 py-5 border-b border-[#1E1E2E]">
          <h2 className="text-lg font-semibold text-white">Blackthorn</h2>
          <p className="text-xs text-[#6B6B80] mt-0.5">TestLab</p>
          <p className="text-[11px] text-[#6B6B80]">Devnet odakli</p>
        </div>

        {/* Navigation */}
        <nav className="flex-1 overflow-auto py-2 px-2">
          <div className="flex flex-col gap-1">
            {pages.map((page) => (
              <button
                key={page.id}
                onClick={() => setActivePage(page.id)}
                className={`text-left px-4 py-3 rounded-lg transition-all duration-150 cursor-pointer ${
                  activePage === page.id
                    ? "bg-[#1A1A28] border-l-[3px] border-l-[#8B5CF6]"
                    : "hover:bg-[#1A1A28]"
                }`}
              >
                <span className={`block text-sm font-semibold ${
                  activePage === page.id ? "text-[#E8E8ED]" : "text-[#E8E8ED]"
                }`}>
                  {page.title}
                </span>
                <span className="block text-xs text-[#6B6B80] mt-0.5">{page.hint}</span>
                <div className="mt-1">
                  <StatusBadge done={page.done} />
                </div>
              </button>
            ))}
          </div>
        </nav>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-[#1E1E2E] text-[11px] font-mono text-[#6B6B80] space-y-1">
          <p>Durum: {isBusy ? `Calisiyor...` : "Hazir"}</p>
          <p>Proxy: /api</p>
          <p>Wallet: {connectedWallet ? connectedWallet.walletName : "Bagli degil"}</p>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 overflow-auto bg-[#0A0A0F]">
        <div className="max-w-[900px] mx-auto px-8 py-8">
          {error && (
            <div className="mb-6 p-4 bg-[#EF4444]/10 border border-[#EF4444]/30 rounded-lg text-sm text-[#EF4444]">
              {error}
            </div>
          )}
          {renderPage()}
        </div>
      </main>
    </div>
  );
}
