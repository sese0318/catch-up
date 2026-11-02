import type { Metadata } from "next";
import Link from "next/link";
import { PrivacyContent } from "@/components/PrivacyContent";
import { PRIVACY, UI } from "@/lib/client/copy";

export const metadata: Metadata = {
  title: "How your audio is handled · Catch Up",
  description: PRIVACY.intro,
};

export default function PrivacyPage() {
  return (
    <main className="cu-doc" lang="en">
      <p>
        <Link href="/" className="cu-doc-back">
          {UI.backToApp}
        </Link>
      </p>
      <h1 className="cu-doc-title">{PRIVACY.title}</h1>
      <PrivacyContent />
    </main>
  );
}
