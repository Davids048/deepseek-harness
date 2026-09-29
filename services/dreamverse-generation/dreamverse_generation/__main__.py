"""Launch the DreamVerse generation backend with the `dreamverse-server` model selection options."""
from __future__ import annotations

import argparse
from pathlib import Path


def cli() -> None:
    """Pass launch choices to generation backend construction and start the HTTP server."""
    import yaml

    from dreamverse.generation.models.configs import get_all_model_capabilities

    parser = argparse.ArgumentParser(prog="python -m dreamverse_generation")
    selection = parser.add_mutually_exclusive_group(required=True)
    selection.add_argument("--preset", choices=[model.model_id for model in get_all_model_capabilities()],
                           help="Model preset to serve")
    selection.add_argument("--config", type=Path, help="FastVideo YAML with an explicit server.served_model_name")
    parser.add_argument("--host", help="Override the configured server address")
    parser.add_argument("--port", type=int, help="Override the configured server port")
    parser.add_argument("--mock", action="store_true", help="Use CPU test media instead of a video model")
    parser.add_argument("--latency",
                        type=int,
                        help="Added generation delay in milliseconds (requires --mock; default: 0)")
    args = parser.parse_args()
    if args.latency is not None and not args.mock:
        parser.error("--latency requires --mock")
    # Application imports load FastVideo, so they follow argument validation.
    from dreamverse_generation.app import create_generation_app

    backend_factory = None
    if args.mock:
        from dreamverse.generation.mock import MockBackendFactory

        backend_factory = MockBackendFactory(latency_ms=0 if args.latency is None else args.latency)
    try:
        app = create_generation_app(
            preset=args.preset,
            config_path=args.config,
            backend_factory=backend_factory,
            host=args.host,
            port=args.port,
        )
    except (ValueError, OSError, yaml.YAMLError) as exc:
        parser.error(str(exc))

    import uvicorn

    uvicorn.run(app, host=app.state.config.server.host, port=app.state.config.server.port,
                ws_max_size=app.state.max_generation_message_bytes)


if __name__ == "__main__":
    cli()
