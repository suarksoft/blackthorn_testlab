"use client";
/* eslint-disable react/no-unescaped-entities */

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
      title: "1. Ortam kontrol",
      hint: "API ve saglik",
      done: !!healthRes && !!readyRes,
    },
    {
      id: "scenario",
      title: "2. Senaryo uret",
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
        <section className="page-card">
          <h1>DeltaG Test Akademi</h1>
          <p>
            Bu ekran bir test panelinden cok, adim adim egitimli bir laboratuvar. Yazilim bilmeyen
            biri bile soldaki adimlari sirayla ilerleyerek "normalde ne olur, DeltaG nasil fark
            yaratir" sorusunu gorebilir.
          </p>
          <div className="compare-grid">
            <article>
              <h3>Normalde</h3>
              <p>
                Kullanici genelde "Approve" tusuna basar. Arka planda ne risk oldugu net
                gosterilmez. Programlar, CPI zinciri, policy etkisi anlasilmaz.
              </p>
            </article>
            <article>
              <h3>DeltaG ile</h3>
              <p>
                Transaction imzalanmadan once simule edilir. Risk bulgulari, bakiye degisimleri,
                policy kurallari ve karar nedeni acik sekilde raporlanir.
              </p>
            </article>
          </div>
          <div className="tips">
            <h3>Baslamadan once</h3>
            <ol>
              <li>Soldan "1. Ortam kontrol" adimina git.</li>
              <li>Sonra "2. Senaryo uret" sayfasinda tx verisini hazirla.</li>
              <li>Kalan tum testleri sirayla calistir.</li>
            </ol>
          </div>
        </section>
      );
    }

    if (activePage === "setup") {
      return (
        <section className="page-card">
          <h1>1) Ortam Kontrol Sayfasi</h1>
          <p>
            Burada sistem ayakta mi diye bakiyoruz. Bu adim fail olursa diger testlerin sonucu
            guvenilir olmaz.
          </p>
          <div className="info-banner">
            <strong>Kullanicidan beklenen:</strong> Sadece cluster secimi ve (varsa) API key.
            Yazilim bilgisi gerekmez.
          </div>
          <div className="form-grid two">
            <label>
              Cluster
              <select value={cluster} onChange={(e) => setCluster(e.target.value as Cluster)}>
                {CLUSTERS.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
            <label>
              API Key (opsiyonel)
              <input
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="Yoksa bos birakabilirsin"
              />
            </label>
          </div>
          <div className="actions">
            <button onClick={onHealthChecks} disabled={!!isBusy}>
              Health + Ready Testini Calistir
            </button>
          </div>
          <div className="form-grid two">
            <ApiBox title="/health sonucu" response={healthRes} />
            <ApiBox title="/health/ready sonucu" response={readyRes} />
          </div>
        </section>
      );
    }

    if (activePage === "scenario") {
      return (
        <section className="page-card">
          <h1>2) Gercek Hayat Senaryosu Olusturma</h1>
          <p>
            Bu sayfa artik sadece rastgele tx uretmiyor; istersen bagli wallet ile gercek test
            transferi hazirlayip analyze'a da sokabiliyorsun.
          </p>
          <div className="wallet-panel">
            <div className="wallet-panel-header">
              <div>
                <h3>Swig / Solana Wallet Baglantisi</h3>
                <p>
                  Wallet Standard destekleyen cuzdanlari otomatik bulur. Swig algilanirsa once onu
                  onerir.
                </p>
              </div>
              <span className={`pill ${connectedWallet ? "connected" : "idle"}`}>
                {connectedWallet ? "Wallet bagli" : "Wallet bagli degil"}
              </span>
            </div>
            <div className="form-grid two">
              <label>
                Bulunan wallet
                <select
                  value={effectiveSelectedWalletId}
                  onChange={(e) => setSelectedWalletId(e.target.value)}
                >
                  {walletOptions.length === 0 ? (
                    <option value="">Wallet bulunamadi</option>
                  ) : (
                    walletOptions.map((wallet) => (
                      <option key={wallet.id} value={wallet.id}>
                        {wallet.name}
                      </option>
                    ))
                  )}
                </select>
              </label>
              <div className="wallet-status-card">
                <strong>{connectedWallet?.walletName ?? "Bagli wallet yok"}</strong>
                <span>{connectedWallet?.address ?? "Wallet secip baglanabilirsin."}</span>
                <span>Bakiye: {formatSol(walletBalanceLamports)}</span>
              </div>
            </div>
            <div className="actions">
              <button onClick={onConnectWallet} disabled={!!isBusy || walletOptions.length === 0}>
                Wallet Bagla
              </button>
              <button onClick={onDisconnectWallet} disabled={!!isBusy || !connectedWallet}>
                Wallet Baglantisini Kes
              </button>
              <button onClick={onRefreshWallets} disabled={!!isBusy}>
                Wallet Listesini Yenile
              </button>
              <button onClick={onRefreshWalletBalance} disabled={!!isBusy || !connectedWallet}>
                Bakiye Yenile
              </button>
              <button
                onClick={onRequestWalletAirdrop}
                disabled={!!isBusy || !connectedWallet || cluster !== "devnet"}
              >
                Devnet Airdrop (1 SOL)
              </button>
            </div>
            <div className="form-grid two">
              <label>
                Recipient adresi
                <input
                  value={walletRecipient}
                  onChange={(e) => setWalletRecipient(e.target.value)}
                  placeholder="Devnet recipient public key"
                />
              </label>
              <label>
                Transfer miktari (lamports)
                <input
                  value={walletLamports}
                  onChange={(e) => setWalletLamports(e.target.value)}
                  placeholder="5000"
                />
              </label>
            </div>
            <div className="actions">
              <button onClick={onGenerateWalletRecipient} disabled={!!isBusy}>
                Yeni Recipient Uret
              </button>
              <button onClick={onPrepareWalletSignedTx} disabled={!!isBusy || !connectedWallet}>
                Wallet ile Sign Et ve Analyze'a Yukle
              </button>
              <button
                onClick={onSendWalletTestTx}
                disabled={!!isBusy || !connectedWallet || cluster !== "devnet"}
              >
                Wallet ile Sign + Send (Devnet)
              </button>
            </div>
          </div>
          <div className="info-banner">
            <strong>Wallet butonlari:</strong> Ilki imzali tx'i sadece analyze icin hazirlar.
            Ikincisi ise gercek devnet transferini yollar ve signature/base64'i otomatik doldurur.
          </div>
          <div className="actions">
            <button onClick={onCreateRealScenario} disabled={!!isBusy}>
              Gercek Devnet Transfer Senaryosu Olustur
            </button>
            <button onClick={onGenerateSampleTx} disabled={!!isBusy}>
              Hizli Demo Tx Uret (Imzasiz)
            </button>
          </div>
          <div className="form-grid two">
            <label>
              Varsa Devnet Signature
              <input
                value={txSignature}
                onChange={(e) => setTxSignature(e.target.value)}
                placeholder="Ornek: 5Q..."
              />
            </label>
            <div className="actions compact">
              <button onClick={onLoadFromSignature} disabled={!!isBusy}>
                Signature'dan Base64 Getir
              </button>
            </div>
          </div>
          <label>
            Hazirlanan Transaction Base64
            <textarea
              rows={8}
              value={txBase64}
              onChange={(e) => setTxBase64(e.target.value)}
              placeholder="Bu alan tum sonraki testlerde kullanilir."
            />
          </label>
          <div className="note">
            <h3>Senaryo Ozeti</h3>
            <pre>{pretty(scenarioMeta)}</pre>
          </div>
        </section>
      );
    }

    if (activePage === "analyze") {
      return (
        <section className="page-card">
          <h1>3) Analyze Sayfasi (Ana Motor)</h1>
          <p>
            Bu adim projenin kalbi. Bir transaction guvenli mi, degil mi? Neden? Hangi bulgularla?
            Bu sayfada cevap gorursun.
          </p>
          <div className="compare-grid">
            <article>
              <h3>Normalde</h3>
              <p>Bir cogu uygulama sadece "onayla" der, teknik detay aciklamaz.</p>
            </article>
            <article>
              <h3>DeltaG Farki</h3>
              <p>Risk findings, reason listesi, semantic ozet, ve policy sonucu birlikte gelir.</p>
            </article>
          </div>
          {connectedWallet ? (
            <div className="info-banner">
              <strong>User wallet context:</strong> Analyze ve batch isteklerine otomatik olarak{" "}
              <code>{connectedWallet.address}</code> eklenecek.
            </div>
          ) : null}
          <label>
            Policy JSON (opsiyonel)
            <textarea rows={5} value={policyJson} onChange={(e) => setPolicyJson(e.target.value)} />
          </label>
          <div className="actions">
            <button onClick={onAnalyze} disabled={!!isBusy}>
              Analyze Testini Calistir
            </button>
          </div>
          {decisionCard ? (
            <div className={`decision ${decisionCard.safe ? "safe" : "block"}`}>
              <strong>{decisionCard.safe ? "SAFE / ALLOW" : "RISKLI / BLOCK"}</strong>
              <p>
                {decisionCard.safe
                  ? "Bu senaryoda karar guvenli gorunuyor."
                  : "Bu senaryoda risk tespit edildi. Asagidaki nedenler aciklamadir."}
              </p>
              <ul>
                {(decisionCard.reasons ?? []).slice(0, 6).map((reason, idx) => (
                  <li key={`${reason}-${idx}`}>{reason}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <ApiBox title="Analyze JSON sonucu" response={analyzeRes} />
        </section>
      );
    }

    if (activePage === "batch") {
      return (
        <section className="page-card">
          <h1>4) Batch Sayfasi</h1>
          <p>
            Ayni anda birden fazla transaction test ederek sistemin tutarliligini gorursun. Gercek
            hayatta entegratorler bu endpointi toplu tarama icin kullanir.
          </p>
          <label>
            Batch Listesi (her satir bir base64)
            <textarea
              rows={8}
              value={batchInput}
              onChange={(e) => setBatchInput(e.target.value)}
              placeholder={"base64-1\nbase64-2"}
            />
          </label>
          <div className="actions">
            <button onClick={onBatch} disabled={!!isBusy}>
              Batch Testini Calistir
            </button>
          </div>
          <ApiBox title="Batch JSON sonucu" response={batchRes} />
        </section>
      );
    }

    if (activePage === "stream") {
      return (
        <section className="page-card">
          <h1>5) Stream (SSE) Sayfasi</h1>
          <p>
            Bu adimda sonuclarin "canli event" olarak akisini gorursun. Uzun batch'lerde ilerleme
            takibi icin idealdir.
          </p>
          <div className="actions">
            <button onClick={onStream} disabled={!!isBusy}>
              Stream Testini Baslat
            </button>
          </div>
          <div className="note">
            <h3>Canli Event Log</h3>
            <pre>{streamEvents.join("\n") || "Henuz event yok."}</pre>
          </div>
        </section>
      );
    }

    if (activePage === "replay") {
      return (
        <section className="page-card">
          <h1>6) Replay Sayfasi</h1>
          <p>
            Replay ayni tx'i tekrar oynatarak "farkli slotta ne degisir?" sorusunu test eder. Bu
            sayfa neden-sonuc karsilastirmasi icin cok onemlidir.
          </p>
          <div className="form-grid two">
            <label>
              Replay slot (opsiyonel)
              <input
                value={slotInput}
                onChange={(e) => setSlotInput(e.target.value)}
                placeholder="Bos birakirsan guncel slot"
              />
            </label>
          </div>
          <div className="actions">
            <button onClick={onReplay} disabled={!!isBusy}>
              Replay Testini Calistir
            </button>
          </div>
          <ApiBox title="Replay JSON sonucu" response={replayRes} />
        </section>
      );
    }

    if (activePage === "audit") {
      return (
        <section className="page-card">
          <h1>7) Audit Sayfasi</h1>
          <p>
            Audit kayitlari, "sistem neyi ne zaman kararlastirmis?" sorusunu cevaplar. Kurumsal
            kullanicilar icin izlenebilirlik adimidir.
          </p>
          <div className="actions">
            <button onClick={onAudit} disabled={!!isBusy}>
              Audit Testini Calistir
            </button>
          </div>
          <div className="form-grid two">
            <ApiBox title="Recent kayitlar" response={auditRecentRes} />
            <ApiBox title="Aggregate ozet" response={auditAggregateRes} />
          </div>
        </section>
      );
    }

    if (activePage === "mcp") {
      return (
        <section className="page-card">
          <h1>8) MCP Sayfasi</h1>
          <p>
            MCP, ajan/yardimci uygulamalarin DeltaG ile konusmasini saglar. Bu sayfada agent
            araclarinin endpoint testini yapiyoruz.
          </p>
          <div className="form-grid two">
            <label>
              MCP Tool
              <select value={mcpTool} onChange={(e) => setMcpTool(e.target.value)}>
                <option value="deltag_health">deltag_health</option>
                <option value="deltag_list_profiles">deltag_list_profiles</option>
                <option value="deltag_analyze">deltag_analyze</option>
              </select>
            </label>
            <label>
              MCP Arguments JSON
              <textarea rows={5} value={mcpArgs} onChange={(e) => setMcpArgs(e.target.value)} />
            </label>
          </div>
          <div className="actions">
            <button onClick={onMcpTools} disabled={!!isBusy}>
              MCP Tools Listele
            </button>
            <button onClick={onMcpCall} disabled={!!isBusy}>
              MCP Call Testi
            </button>
          </div>
          <div className="form-grid two">
            <ApiBox title="MCP tools sonucu" response={mcpToolsRes} />
            <ApiBox title="MCP call sonucu" response={mcpCallRes} />
          </div>
        </section>
      );
    }

    return (
      <section className="page-card">
        <h1>9) x402 Sayfasi</h1>
        <p>
          x402, API cagrisini odeme ile koruyan bir modeldir. Bu testte API key olmadan cagirip
          sistemin 402 dondugunu goruruz. Boylece odeme kapisi aktif mi anlarsin.
        </p>
        <div className="info-banner">
          <strong>Beklenen sonuc:</strong> x402 aciksa HTTP 402 ve payment-required header gelir.
          API key ile cagirdiginda ise normal endpoint akisi gorursun.
        </div>
        <div className="actions">
          <button onClick={onX402Probe} disabled={!!isBusy}>
            x402 Probe Testini Calistir (API key'siz)
          </button>
        </div>
        <ApiBox title="x402 probe sonucu" response={x402ProbeRes} />
      </section>
    );
  }

  return (
    <main className="shell">
      <aside className="sidebar">
        <div className="brand">
          <h2>DeltaG TestLab</h2>
          <p>
            Adim adim test akademisi
            <br />
            (Devnet odakli)
          </p>
        </div>
        <nav className="nav">
          {pages.map((page) => (
            <button
              key={page.id}
              className={`nav-item ${activePage === page.id ? "active" : ""}`}
              onClick={() => setActivePage(page.id)}
            >
              <span>{page.title}</span>
              <small>{page.hint}</small>
              <b className={page.done ? "done" : "pending"}>{page.done ? "Tamam" : "Bekliyor"}</b>
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <p>Durum: {isBusy ? `Calisiyor (${isBusy})` : "Hazir"}</p>
          <p>Proxy: /api</p>
          <p>Wallet: {connectedWallet ? connectedWallet.walletName : "Bagli degil"}</p>
        </div>
      </aside>

      <section className="content">
        {error ? <p className="error">{error}</p> : null}
        {renderPage()}
      </section>
    </main>
  );
}

function ApiBox({ title, response }: { title: string; response: ApiResponse | null }) {
  return (
    <div className="box">
      <h3>{title}</h3>
      {response ? (
        <>
          <p className={`status ${response.ok ? "ok" : "bad"}`}>
            HTTP {response.status} {response.ok ? "OK" : "HATA"}
          </p>
          <pre>{JSON.stringify(response.data, null, 2)}</pre>
          <details>
            <summary>Header detaylari</summary>
            <pre>{pretty(response.headers)}</pre>
          </details>
        </>
      ) : (
        <p className="muted">Henuz istek gonderilmedi.</p>
      )}
    </div>
  );
}
