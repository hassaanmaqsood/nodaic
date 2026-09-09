# Nodaic

Nodaic is an execution engine where systems are modeled as networks of nodes — each node takes input, runs a process, and passes output forward. Graphs of nodes are themselves nodes, so any system built once becomes a reusable building block for a larger one.

You define Processes (functions), connect them into a Graph via edges, and store everything in a Library; when the engine runs, each node executes its process, publishes its output, and downstream nodes automatically receive it as their input. The agent exposes this over HTTP and WebSocket, so any external event — a webhook, a schedule, a user action — can trigger the right graph in real time.

Clone its [nodejs runtime](./runtimes/node) and use it as a template for your project; you can also use [nodaic studio](./nodaic_studio/) for a user interface.

In future, I would be introducing WASM runtime for browser, esp32 runtime, TUI for studio, installation of artifacts to extend built-in processes and graphs, SSO, and many more.

