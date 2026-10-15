import type { Metadata } from "next";
import { AgreementView } from "@/components/account/AgreementView";

export const metadata: Metadata = {
  title: "Data agreement — AgroTwin",
};

/** Signed in, before anything else: a farmer reads and accepts the data agreement
 * (shown when one is set on the server and the farmer has not accepted this version). */
export default function AgreementPage() {
  return <AgreementView />;
}
