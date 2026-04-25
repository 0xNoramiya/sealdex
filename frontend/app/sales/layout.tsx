import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Catalog",
  description: "A live sealed-bid auction with autonomous bidders.",
};

export default function SalesLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
