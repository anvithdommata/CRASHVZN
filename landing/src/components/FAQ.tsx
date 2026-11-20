import { Reveal } from "@/components/Motion";
import { Plus } from "lucide-react";

const faqs = [
  {
    question: "Is CRASHVZN a certified forensic tool?",
    answer:
      "No. CRASHVZN is a reconstruction and exploration workspace. Its outputs are estimates derived from the footage and configured scale, and the app exposes uncertainty where the pipeline provides it. Treat it as a way to understand and communicate an incident — not a substitute for a certified investigation or expert testimony.",
  },
  {
    question: "What footage can I load?",
    answer:
      "The desktop app accepts MP4, MOV, MKV, and other common video files. The included reference incident uses a four-camera mosaic. Reconstruction quality depends on the source: camera calibration, sync, and visible vehicle geometry all matter. The current build is tuned to the reference scene package and staged footage workflows.",
  },
  {
    question: "Do I need a Claude, Codex, or Gemini subscription?",
    answer:
      "Yes. You need a subscription that provides access to Claude Code, Codex, or Gemini CLI, signed in on your machine. CRASHVZN uses the connected LLM for both the scene assistant and the video-rendering workflow. Your provider subscription is separate from CRASHVZN.",
  },
  {
    question: "Where does my footage go?",
    answer:
      "Nowhere by default. The app copies and hashes selected footage into a local incident workspace, and reconstructed scenes are read from your disk. Exports are saved to your machine. The reference pipeline can also run on your own GPU or a compute host you control.",
  },
  {
    question: "How accurate are the speeds and positions?",
    answer:
      "The reference package reports per-sample position and speed uncertainty; the app keeps those bands visible instead of reducing everything to a single confident number. Absolute speed can be biased when scale is inferred from a configured focal length, while relative timing around an impact is usually more reliable. Always phrase findings as reconstruction estimates.",
  },
  {
    question: "Is it free?",
    answer:
      "The CRASHVZN app is free during beta. A separate Claude, Codex, or Gemini subscription is required for the LLM-powered assistant and video-rendering workflow. The app is built on open-source projects including OpenSplat, Spark, Three.js, React, and Electron. See the repository's CREDITS.md for licenses and assets.",
  },
];

export function FAQ() {
  return (
    <section className="section-pad faq-section" id="faq">
      <div className="container-x faq-grid">
        <Reveal className="faq-intro">
          <h2>A little more clarity.</h2>
          <p>
            Reconstruction is a tool for understanding, not a verdict. Here’s what the app does,
            what it doesn’t, and where your evidence lives.
          </p>
          <a href="https://github.com/anvithdommata/CRASHVZN#readme" target="_blank" rel="noreferrer">
            Read the project docs <span>↗</span>
          </a>
        </Reveal>

        <Reveal className="faq-list" delay={0.08}>
          {faqs.map((faq, index) => (
            <details className="faq-item" key={faq.question} open={index === 0}>
              <summary>
                <span className="faq-question">{faq.question}</span>
                <span className="faq-plus"><Plus size={16} /></span>
              </summary>
              <div className="faq-answer">
                <p>{faq.answer}</p>
              </div>
            </details>
          ))}
        </Reveal>
      </div>
    </section>
  );
}
