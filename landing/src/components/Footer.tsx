import { Wordmark } from "@/components/Brand";
import { ArrowUpRight, Github } from "lucide-react";

const columns = [
  {
    title: "Product",
    links: [
      { label: "Workflow", href: "#workflow" },
      { label: "Scene assistant", href: "#assistant" },
      { label: "Download", href: "#download" },
    ],
  },
  {
    title: "Project",
    links: [
      { label: "GitHub", href: "https://github.com/anvithdommata/CRASHVZN" },
      { label: "Releases", href: "https://github.com/anvithdommata/CRASHVZN/releases" },
      { label: "Credits", href: "https://github.com/anvithdommata/CRASHVZN/blob/main/CREDITS.md" },
    ],
  },
  {
    title: "Read",
    links: [
      { label: "FAQ", href: "#faq" },
      { label: "Requirements", href: "#download" },
      { label: "Contact", href: "mailto:hello@crashvzn.us" },
    ],
  },
];

export function Footer() {
  return (
    <footer className="site-footer">
      <div className="container-x">
        <div className="footer-top">
          <div className="footer-brand">
            <Wordmark />
            <p>
              Crash reconstruction, in four dimensions. Built for the people who have to explain
              what happened.
            </p>
            <a href="mailto:hello@crashvzn.us" className="footer-email">hello@crashvzn.us</a>
            <div className="footer-badges">
              <span>Sunhacks 2026</span>
              <span>Local-first</span>
            </div>
          </div>

          <div className="footer-columns">
            {columns.map((column) => (
              <div className="footer-column" key={column.title}>
                <span>{column.title}</span>
                {column.links.map((link) => (
                  <a
                    key={link.label}
                    href={link.href}
                    target={link.href.startsWith("#") || link.href.startsWith("mailto:") ? undefined : "_blank"}
                    rel={link.href.startsWith("#") || link.href.startsWith("mailto:") ? undefined : "noreferrer"}
                  >
                    {link.label}
                    {!link.href.startsWith("#") && !link.href.startsWith("mailto:") && <ArrowUpRight size={11} />}
                  </a>
                ))}
              </div>
            ))}
          </div>
        </div>

        <div className="footer-wordmark" aria-hidden="true">CRASHVZN</div>

        <div className="footer-bottom">
          <span>© 2026 CRASHVZN · crashvzn.us</span>
          <span className="footer-disclaimer">
            Reconstruction estimates only. Not a substitute for a certified forensic investigation.
          </span>
          <div className="footer-bottom-right">
            <a href="https://github.com/anvithdommata/CRASHVZN" target="_blank" rel="noreferrer">
              <Github size={13} /> Source
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}
