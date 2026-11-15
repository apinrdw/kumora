// Parsed holdings' vocabulary, shared by the server's reads and the stock
// page: the 39 investor classifications and KSEI's 9 investor types.

// KSEI's 9 investor types.
export const KSEI_TYPES = [
  "ID",
  "CP",
  "MF",
  "IB",
  "IS",
  "SC",
  "PF",
  "FD",
  "OT",
] as const
export type KseiType = (typeof KSEI_TYPES)[number]

export const KSEI_TYPE_LABELS: Record<KseiType, string> = {
  ID: "Individual",
  CP: "Corporate",
  MF: "Mutual fund",
  IB: "Financial institution",
  IS: "Insurance",
  SC: "Securities company",
  PF: "Pension fund",
  FD: "Foundation",
  OT: "Others",
}

// The 39 investor classifications, by the slug parsed holdings store, each
// with its label and its KSEI investor type.
// Decision: the owner's fixed 39 → 9 mapping, from the prototype; it never
// reconciles with KSEI's own type totals. See apinrdw/kumora#354.
export const CLASSIFICATIONS = {
  bank: { label: "Bank", type: "IB" },
  government: { label: "Government", type: "OT" },
  private_equity: { label: "Private equity", type: "CP" },
  trustee_bank: { label: "Trustee bank", type: "IB" },
  venture_capital: { label: "Venture capital", type: "CP" },
  private_bank: { label: "Private bank", type: "IB" },
  exchange_traded_funds: { label: "Exchange traded funds", type: "MF" },
  investment_manager: { label: "Investment manager", type: "SC" },
  investment_advisors: { label: "Investment advisors", type: "OT" },
  brokerage_firms: { label: "Brokerage firms", type: "SC" },
  hedge_fund: { label: "Hedge fund", type: "MF" },
  sovereign_wealth_fund: { label: "Sovereign wealth fund", type: "OT" },
  capital_market_supporting: {
    label: "Capital market support institutions",
    type: "OT",
  },
  cv_limited_partnership: { label: "CV / limited partnership", type: "CP" },
  firm: { label: "Firm", type: "CP" },
  investment_fund_selling_agent: {
    label: "Investment fund selling agent",
    type: "OT",
  },
  peer_to_peer_lending: { label: "Peer to peer lending", type: "CP" },
  permanent_establishment: { label: "Permanent establishment", type: "CP" },
  sole_proprietorship: { label: "Sole proprietorship", type: "CP" },
  corporate: { label: "Corporate", type: "CP" },
  association: { label: "Associations / social organisations", type: "OT" },
  state_owned_enterprises: { label: "State owned enterprises", type: "CP" },
  central_bank: { label: "Central bank", type: "OT" },
  state_owned_company: { label: "State owned company", type: "CP" },
  diocese: { label: "Diocese", type: "OT" },
  conference: { label: "Conference", type: "OT" },
  congregation: { label: "Congregation", type: "OT" },
  cooperatives: { label: "Cooperatives", type: "IB" },
  international_organization: {
    label: "International organization",
    type: "OT",
  },
  political_parties: { label: "Political parties", type: "OT" },
  partnership: { label: "Partnership", type: "CP" },
  educational_institution: { label: "Educational institution", type: "FD" },
  mutual_funds: { label: "Mutual funds", type: "MF" },
  securities_company: { label: "Securities company", type: "SC" },
  pension_funds: { label: "Pension funds", type: "PF" },
  financial_institutional: { label: "Financial institutions", type: "IB" },
  insurance: { label: "Insurance", type: "IS" },
  foundation: { label: "Foundation", type: "FD" },
  individual: { label: "Individual", type: "ID" },
} as const satisfies Record<
  string,
  { readonly label: string; readonly type: KseiType }
>
export type Classification = keyof typeof CLASSIFICATIONS
