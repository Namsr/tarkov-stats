export const PROJECT_LINKS = {
  github: "https://github.com/Namsr/tarkov-stats",
  discord: "https://discord.gg/aKqG9JgC2X",
  twitch: "https://www.twitch.tv/namsr__",
  email: "mailto:namsrr@protonmail.com",
} as const;

export const DONATION_LINKS = [
  { name: "DonatePay", href: "https://donatepay.ru/don/namsr" },
  { name: "DonationAlerts", href: "https://www.donationalerts.com/r/namsr_hero" },
] as const;

export const BANK_CARD = {
  number: "2200 7019 8380 3161",
  details: "Т-Банк · Намср С.",
} as const;

export interface CryptoMethod {
  asset: "USDT" | "BTC" | "ETH";
  network: "TON" | "Ethereum (ERC20)" | "Bitcoin";
  address: string;
  qrSrc: string;
}

export const CRYPTO_METHODS: readonly CryptoMethod[] = [
  {
    asset: "USDT",
    network: "TON",
    address: "UQAWejo9yU6tSRQWJnkwYmJwTB4554wUGG4QojjkPc2J-S4L",
    qrSrc: "/support/qr/usdt-ton.png",
  },
  {
    asset: "USDT",
    network: "Ethereum (ERC20)",
    address: "0xbff643702135f3d92f279884a7b47cc82acb4fe9",
    qrSrc: "/support/qr/usdt-ethereum-erc20.png",
  },
  {
    asset: "BTC",
    network: "Bitcoin",
    address: "18cHYn7QriHgadvLEioPU7Hr1DE9JHocNG",
    qrSrc: "/support/qr/btc-bitcoin.png",
  },
  {
    asset: "ETH",
    network: "Ethereum (ERC20)",
    address: "0xbff643702135f3d92f279884a7b47cc82acb4fe9",
    qrSrc: "/support/qr/eth-ethereum-erc20.png",
  },
] as const;
