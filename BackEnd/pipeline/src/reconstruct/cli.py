"""Typer commands: build a scene package from the mosaic, or validate one."""

from __future__ import annotations

from pathlib import Path
from typing import Annotated

import typer

from reconstruct.build import build_package
from reconstruct.paths import default_config
from reconstruct.validate import validate_package

app = typer.Typer(
    add_completion=False,
    no_args_is_help=True,
    help="Build and check traffic-incident scene packages.",
)


@app.command()
def build(
    config: Annotated[
        Path | None,
        typer.Option("--config", "-c", help="Pipeline yaml. Defaults to the incident-demo config."),
    ] = None,
    out: Annotated[
        Path | None,
        typer.Option("--out", help="Scene package directory to replace."),
    ] = None,
) -> None:
    """Track vehicles in the mosaic and write the scene package."""
    result = build_package(config or default_config(), out=out)
    event_list = ", ".join(result.events) if result.events else "none"
    typer.echo(
        f"Wrote {result.package_dir} ({result.vehicles} vehicles, {result.samples} samples, "
        f"events: {event_list})"
    )


@app.command()
def validate(
    package: Annotated[Path, typer.Argument(help="Scene package directory.")],
) -> None:
    """Check a scene package against the JSON Schemas and folder contract."""
    errors = validate_package(package)
    if errors:
        for error in errors:
            typer.echo(error, err=True)
        raise typer.Exit(code=1)
    typer.echo(f"{package} matches the scene-package schema")
