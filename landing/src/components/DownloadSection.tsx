import { DownloadButton, DownloadMeta } from "@/components/DownloadButton";
import { InstallCommands } from "@/components/InstallCommands";
import { Reveal } from "@/components/Motion";
import { ArrowUpRight } from "lucide-react";
import { useDownloadTarget } from "@/lib/download";

export function DownloadSection() {
  const target = useDownloadTarget();
  return (
    <section className="section-pad download-section" id="download">
      <div className="container-x">
        <Reveal className="download-card">
          <div className="download-copy">
            <h2>A new view<br />starts here.</h2>
            <p>A local workspace for reconstructing incidents and explaining what happened. Free during beta.</p>
            <div className="download-actions">
              <DownloadButton label="Get CRASHVZN" />
              <a className="text-link" href="https://github.com/anvithdommata/CRASHVZN" target="_blank" rel="noreferrer">Explore the source <ArrowUpRight size={16} /></a>
            </div>
            <div className="download-notes">
              <DownloadMeta />
              {!target.direct && <p>Install from source while desktop installers are on the way.</p>}
            </div>
            <details className="download-source">
              <summary>Build from source</summary>
              <InstallCommands />
            </details>
          </div>
          <aside className="download-requirements" aria-label="System requirements">
            <div><span>Available for</span><p>macOS 13+<br />Windows 10 / 11<br />Linux x64</p></div>
            <div><span>What you need</span><p>WebGL2-capable GPU<br />8 GB RAM</p></div>
            <div><span>On your terms</span><p>Local files. Local exports.<br />No account required.</p></div>
            <div><span>Required LLM subscription</span><p>Claude Code, Codex,<br />or Gemini CLI</p></div>
          </aside>
        </Reveal>
      </div>
    </section>
  );
}
