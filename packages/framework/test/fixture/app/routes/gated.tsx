import { useQuery } from "@archlast/forge-react";
import { anyApi } from "@archlast/forge-runtime";
import { Component, type ReactNode } from "react";

const api = anyApi;

class Boundary extends Component<{ children: ReactNode }, { error?: Error }> {
  state: { error?: Error } = {};
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    return this.state.error ? (
      <div>
        <p id="err">{this.state.error.message}</p>
        <button id="retry" onClick={() => this.setState({ error: undefined })}>Try again</button>
      </div>
    ) : (
      this.props.children
    );
  }
}

function Ready() {
  const value = useQuery(api.messages.gated) as string | undefined;
  return <p id="ready">{value ?? "loading"}</p>;
}

export default function Gated() {
  return (
    <Boundary>
      <Ready />
    </Boundary>
  );
}
