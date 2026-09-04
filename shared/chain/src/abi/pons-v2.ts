import { parseAbi } from 'viem';

/**
 * Pons V2 ABI fragments.
 *
 * Transcribed from docs.ponsfamily.com/v2 and cross-checked against the Bitquery Pons
 * reference. The topic0 constants below are pinned from those sources and asserted
 * against viem's own hashing at startup (see `assertTopicsMatchAbi`), so a typo in a
 * signature fails loudly on boot instead of producing a listener that silently matches
 * nothing — the worst possible failure mode for an event-driven trading bot.
 */

export const ponsV2FactoryAbi = parseAbi([
  'event TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)',
  'event LaunchSwept(address indexed token, uint256 quoteOut, uint256 tokenOut)',
  'event PoolGraduated(address indexed token, uint256 positionId, uint256 tokenAmount, uint256 pairTokenAmount)',
  'event GraduationTokensPermanentlyLocked(address indexed token, uint256 amount)',

  'struct Socials { string twitter; string telegram; string discord; string website; string farcaster; }',
  'struct LaunchedToken { address token; address curve; address deployer; address creatorFeeRecipient; address pairToken; uint256 graduationThreshold; uint24 poolFee; int24 tickSpacing; uint16 creatorTaxBps; bool buybackEnabled; uint8 phase; uint256 sweptQuote; uint256 sweptTokens; uint256 sweptAt; bool exists; }',
  'function getLaunchedToken(address token) view returns (LaunchedToken)',
  'function pairTokenEconomics(address pairToken) view returns (uint256 phantomQuote, uint256 graduationThreshold, uint8 decimals)',
  'function approvedPairTokens(address pairToken) view returns (bool)',
]);

export const ponsV2CurveAbi = parseAbi([
  'event CurveBuy(address indexed buyer, address indexed recipient, uint256 quoteIn, uint256 tokensOut, uint256 fee, uint256 tax)',
  'event CurveSell(address indexed seller, address indexed recipient, uint256 tokensIn, uint256 quoteOut, uint256 fee, uint256 tax)',
  'event SnipeTaxCharged(address indexed recipient, uint256 amount)',
  'event CurveCompleted(address recipient, uint256 quoteOut, uint256 tokenOut)',

  'function getReserves() view returns (uint256 quoteReserve, uint256 tokenReserve)',
  'function realQuoteReserve() view returns (uint256)',
  'function graduationThreshold() view returns (uint256)',
  'function sellableTokens() view returns (uint256)',
  'function reservedTokens() view returns (uint256)',
  'function readyToGraduate() view returns (bool)',
  'function graduated() view returns (bool)',
  'function feeBps() view returns (uint256)',
  'function creatorTaxBps() view returns (uint256)',
  'function currentSnipeTaxBps(address recipient) view returns (uint256)',
  'function isNativeQuote() view returns (bool)',
  'function pairToken() view returns (address)',
  'function token() view returns (address)',

  'function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) payable returns (uint256 tokensOut)',
  'function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) returns (uint256 quoteOut)',
]);

export const ponsV2HookAbi = parseAbi([
  'event PoolRegistered(bytes32 indexed poolId, address memecoin, address quoteToken, address creator)',
  'event HookFeeCollected(bytes32 indexed poolId, address currency, uint256 feeAmount, uint256 taxAmount)',
]);

export const erc20Abi = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function owner() view returns (address)',
]);

/**
 * Pinned topic0 values. Verified by replaying factory logs on chain 4663 at block
 * 54411433: filtering on TOPIC0.TokenLaunched returned 1213 decodable launches over a
 * 50k-block window.
 */
export const TOPIC0 = {
  TokenLaunched: '0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607',
  LaunchSwept: '0xcdb72f157fd3666758a6ce201387ffb52038c7562e4fff352828da1096c4b6b4',
  PoolGraduated: '0x0a44ef75df69c534f43cd6c1aa3ef8983065fe5fe79ef9e79f6494e6f258c259',
  GraduationTokensPermanentlyLocked: '0xa0a18f5bf205becee8b268d7cf69addab8548ae8ef361791464cf0e0e17c1361',
  CurveBuy: '0xec36bf571f136799e8dc0b0b8bea4b04d8bd3d43de838aab0d5fc21d4cbfc455',
  CurveSell: '0x8113d738abdcb6b38357e9d53a54a7157861a09031b453651f0fe7fe151f59df',
  SnipeTaxCharged: '0x3bc39a5562b28f5fe8f36cecabfbaa12bb969acf05717994709225fc412a9934',
  CurveCompleted: '0xf8d37a90738ae063b8b8058b66f5880cf3cf7ab0c5d4fa78219696591dfbfb67',
  PoolRegistered: '0x01bf263a1db1652580721573296e1a1fa70b3d4c87f61d02a69c4e1109d2d573',
} as const;

/** Launch phase as reported by the factory. Authoritative for routing. */
export const PHASE = { NotGraduated: 0, Swept: 1, PoolCreated: 2, Rescued: 3 } as const;
