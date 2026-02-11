import { useState } from "react";
import StatusBanner from "../StatusBanner";
import { UiState } from "../../types";

type Props = {
  state: UiState;
  message: string;
  details?: string;
  hasApiResult: boolean;
  latencyMs: number | null;
  apiBase: string;
  apiOutput: string;
  onApiBaseChange: (value: string) => void;
  onHealth: () => void;
  onRetry: () => void;
};

export default function ApiCard(props: Props) {
  const [showDetails, setShowDetails] = useState(false);
  const statusLine =
    props.state === "success" ? "Backend erreichbar" : props.state === "error" ? "Backend nicht erreichbar" : "Noch nicht geprüft";
  const latencyLabel = props.latencyMs ? `${props.latencyMs} ms` : "keine Messung";

  return (
    <section id="apiCard" className="card reveal" data-state={props.state}>
      <div className="card-title-row">
        <h2>API Verbindung</h2>
        {props.state === "loading" ? <span className="card-title-spinner" aria-hidden="true" /> : null}
      </div>
      <StatusBanner state={props.state} message={props.message} details={props.details} />
      <div className={`api-status-line ${props.state === "success" ? "is-online" : "is-offline"}`}>
        <span className="api-status-title">{statusLine}</span>
        <span className="api-status-dot" />
        <span className="api-status-latency">Latenz: {latencyLabel}</span>
      </div>

      <div className="row">
        <label htmlFor="apiBase">Backend-URL</label>
        <input id="apiBase" value={props.apiBase} onChange={(e) => props.onApiBaseChange(e.target.value)} />
        <button className="btn" onClick={props.onHealth} disabled={props.state === "loading"}>
          Verbinden
        </button>
      </div>
      {props.state === "error" ? (
        <div className="empty-actions">
          <button className="chip" onClick={props.onRetry}>
            Erneut versuchen
          </button>
        </div>
      ) : null}

      {props.hasApiResult ? (
        <div className="api-details-wrap">
          <button className="chip" onClick={() => setShowDetails((v) => !v)}>
            {showDetails ? "Details verbergen" : "Details anzeigen"}
          </button>
          {showDetails ? <pre className="output">{props.apiOutput}</pre> : null}
        </div>
      ) : null}
    </section>
  );
}
