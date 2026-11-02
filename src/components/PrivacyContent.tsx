// How your audio is handled (ux-spec 5 item 9). No hooks, so the privacy page can render it on the
// server and the sheet can reuse it in the app.
import { PRIVACY } from "@/lib/client/copy";

export function PrivacyContent({ headingLevel = 2 }: { headingLevel?: 2 | 3 }) {
  const Heading = headingLevel === 2 ? "h2" : "h3";
  return (
    <div className="cu-privacy" lang="en">
      <p className="cu-privacy-intro">{PRIVACY.intro}</p>
      {PRIVACY.sections.map((section) => (
        <section key={section.title} className="cu-privacy-section">
          <Heading className="cu-privacy-title">{section.title}</Heading>
          <ul>
            {section.items.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>
      ))}
      <section className="cu-privacy-section">
        <Heading className="cu-privacy-title">{PRIVACY.linksTitle}</Heading>
        <ul>
          {PRIVACY.links.map((link) => (
            <li key={link.href}>
              <a href={link.href} target="_blank" rel="noopener noreferrer">
                {link.label}
              </a>
            </li>
          ))}
        </ul>
      </section>
      <p className="cu-built-with">{PRIVACY.builtWith}</p>
    </div>
  );
}
