// Parsed holdings' vocabulary, shared by the server's reads and the stock
// page: origins, the 39 investor classifications and KSEI's 9 investor
// types.
import { Schema } from "effect"

// Whether holdings are local or foreign: KSEI's holdings always are, and a
// split classification report month's.
export const SplitOrigin = Schema.Literals(["local", "foreign"])
export type SplitOrigin = typeof SplitOrigin.Type

// Holdings' origin: combined is a classification report's local and foreign
// together, or all it reports before the split.
export const Origin = Schema.Literals([...SplitOrigin.literals, "combined"])
export type Origin = typeof Origin.Type

// KSEI's 9 investor types, in the stock page's order.
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
export const KseiType = Schema.Literals(KSEI_TYPES)
export type KseiType = typeof KseiType.Type

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
// with its label, its header label as both classification report layouts
// print it (once lowercased and with any `Local_`/`Foreign_` prefix dropped),
// and its KSEI investor type.
// Decision: the owner's fixed 39 → 9 mapping, from the prototype; it never
// reconciles with KSEI's own type totals. See apinrdw/kumora#354.
export const CLASSIFICATIONS = {
  bank: {
    label: "Bank",
    header: "bank",
    type: "IB",
  },
  government: {
    label: "Government",
    header: "government",
    type: "OT",
  },
  private_equity: {
    label: "Private equity",
    header: "private equity",
    type: "CP",
  },
  trustee_bank: {
    label: "Trustee bank",
    header: "trustee bank",
    type: "IB",
  },
  venture_capital: {
    label: "Venture capital",
    header: "venture capital",
    type: "CP",
  },
  private_bank: {
    label: "Private bank",
    header: "private bank",
    type: "IB",
  },
  exchange_traded_funds: {
    label: "Exchange traded funds",
    header: "exchange traded funds",
    type: "MF",
  },
  investment_manager: {
    label: "Investment manager",
    header: "investment manager",
    type: "SC",
  },
  investment_advisors: {
    label: "Investment advisors",
    header: "investment advisors",
    type: "OT",
  },
  brokerage_firms: {
    label: "Brokerage firms",
    header: "brokerage firms",
    type: "SC",
  },
  hedge_fund: {
    label: "Hedge fund",
    header: "hedge fund",
    type: "MF",
  },
  sovereign_wealth_fund: {
    label: "Sovereign wealth fund",
    header: "sovereign wealth fund",
    type: "OT",
  },
  capital_market_supporting: {
    label: "Capital market support institutions",
    header: "capital market supporting institutions and professions",
    type: "OT",
  },
  cv_limited_partnership: {
    label: "CV / limited partnership",
    header: "commanditaire vennootschap (cv) or limited partnership",
    type: "CP",
  },
  firm: {
    label: "Firm",
    header: "firm",
    type: "CP",
  },
  investment_fund_selling_agent: {
    label: "Investment fund selling agent",
    header: "investment fund selling agent",
    type: "OT",
  },
  peer_to_peer_lending: {
    label: "Peer to peer lending",
    header: "peer to peer lending",
    type: "CP",
  },
  permanent_establishment: {
    label: "Permanent establishment",
    header: "permanent establishment",
    type: "CP",
  },
  sole_proprietorship: {
    label: "Sole proprietorship",
    header: "sole proprietorship",
    type: "CP",
  },
  corporate: {
    label: "Corporate",
    header: "corporate",
    type: "CP",
  },
  association: {
    label: "Associations / social organisations",
    header: "association/social organizations",
    type: "OT",
  },
  state_owned_enterprises: {
    label: "State owned enterprises",
    header: "state owned enterprises",
    type: "CP",
  },
  central_bank: {
    label: "Central bank",
    header: "central bank",
    type: "OT",
  },
  state_owned_company: {
    label: "State owned company",
    header: "state owned company",
    type: "CP",
  },
  diocese: {
    label: "Diocese",
    header: "diocese",
    type: "OT",
  },
  conference: {
    label: "Conference",
    header: "conference",
    type: "OT",
  },
  congregation: {
    label: "Congregation",
    header: "congregation",
    type: "OT",
  },
  cooperatives: {
    label: "Cooperatives",
    header: "cooperatives",
    type: "IB",
  },
  international_organization: {
    label: "International organization",
    header: "international organization",
    type: "OT",
  },
  political_parties: {
    label: "Political parties",
    header: "political parties",
    type: "OT",
  },
  partnership: {
    label: "Partnership",
    header: "partnership",
    type: "CP",
  },
  educational_institution: {
    label: "Educational institution",
    header: "educational institution",
    type: "FD",
  },
  mutual_funds: {
    label: "Mutual funds",
    header: "mutual funds (mf)",
    type: "MF",
  },
  securities_company: {
    label: "Securities company",
    header: "securities company (sc)",
    type: "SC",
  },
  pension_funds: {
    label: "Pension funds",
    header: "pension funds (pf)",
    type: "PF",
  },
  financial_institutional: {
    label: "Financial institutions",
    header: "financial institutional (ib)",
    type: "IB",
  },
  insurance: {
    label: "Insurance",
    header: "insurance (is)",
    type: "IS",
  },
  foundation: {
    label: "Foundation",
    header: "foundation (fd)",
    type: "FD",
  },
  individual: {
    label: "Individual",
    header: "individual (id)",
    type: "ID",
  },
} as const satisfies Record<
  string,
  {
    readonly label: string
    readonly header: string
    readonly type: KseiType
  }
>
export const Classification = Schema.Literals(
  Object.keys(CLASSIFICATIONS) as ReadonlyArray<keyof typeof CLASSIFICATIONS>
)
export type Classification = typeof Classification.Type
