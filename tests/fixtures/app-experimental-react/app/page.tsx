import React from "react";
import ReactDOM from "react-dom";
import ClientReact from "./client-react";

export default function Page() {
  return (
    <main>
      <p id="react">React.version={React.version}</p>
      <p id="react-dom">ReactDOM.version={ReactDOM.version}</p>
      <ClientReact />
    </main>
  );
}
