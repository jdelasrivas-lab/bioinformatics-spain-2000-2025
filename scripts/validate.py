#!/usr/bin/env python3
"""Check the static explorer using Python's standard library and Node.js.

From the repository root, run ``python3 scripts/validate.py``. Checks resolve
paths relative to this script, rather than the current working directory.
The script finds index.html at the repository root or in site/. Use ``--site site``
or ``--site .`` to select explicitly when both layouts exist.

This checks source structure, local references and supplied dataset integrity.
It does not render a browser, verify remote URLs or replace interaction tests.
Validation never rewrites research data or regenerates its manifest.
"""

import argparse
import hashlib
import json
import math
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlsplit
from xml.etree import ElementTree


PROJECT_ROOT = Path(__file__).resolve().parents[1]
RESEARCH_SECTIONS = ("explore", "publications", "evaluation", "methods")
DEFAULT_SOLUTION = "leiden_r0.5"
VOID_ELEMENTS = frozenset(
    "area base br col embed hr img input link meta param source track wbr".split()
)
JSON_SCRIPT_TYPES = frozenset({"application/json", "application/ld+json"})
ID_REFERENCE_ATTRIBUTES = ("for", "aria-controls", "aria-labelledby", "aria-describedby")

# Literal references only: these patterns do not attempt to parse JavaScript.
# Node.js performs the actual syntax check for each script.
JS_ELEMENT_REFERENCE = re.compile(
    r"(?:\$|document\.getElementById)\(\s*(['\"])([^'\"]+)\1\s*\)"
)
JS_MODULE_REFERENCE = re.compile(r"\bfrom\s+['\"]([^'\"]+)['\"]")
JS_DATA_REFERENCE = re.compile(
    r"new\s+URL\(\s*['\"]([^'\"]+)['\"]\s*,\s*import\.meta\.url\s*\)"
)
JS_FETCH_REFERENCE = re.compile(r"\bfetch\(\s*['\"]([^'\"]+)['\"]")


class ValidationError(Exception):
    """An actionable failure in a project file or required local dependency."""


def require(condition, message):
    """Keep checks active under python -O, which disables assert statements."""
    if not condition:
        raise ValidationError(message)


@dataclass
class OpenElement:
    """Track an element's identity independently of its attributes or line."""

    tag: str
    attributes: dict
    line: int
    serial: int


class Structure(HTMLParser):
    """Collect the explorer's DOM contract while checking explicit tag nesting.

    The project uses explicit closing tags. This is a focused project checker,
    not a general HTML conformance validator for optional end-tag syntax.
    """

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack = []
        self.ids = {}
        self.links = []
        self.references = []
        self.sections = {}
        self.scripts = []
        self.language = None
        self.serial = 0

    def handle_starttag(self, tag, attributes):
        attributes = dict(attributes)
        line = self.getpos()[0]
        self.serial += 1
        element = OpenElement(tag, attributes, line, self.serial)
        identifier = attributes.get("id")

        if identifier:
            require(identifier not in self.ids, f"Duplicate ID: {identifier} (line {line})")
            self.ids[identifier] = element
        if tag == "html":
            self.language = attributes.get("lang")
        if tag == "section" and identifier:
            self.sections[identifier] = tuple(
                entry.serial for entry in self.stack
                if "container" in (entry.attributes.get("class") or "").split()
            )
        if tag in {"a", "use", "link", "img", "script"}:
            url = attributes.get("href") or attributes.get("src")
            if url:
                self.links.append(url)
        if tag == "script":
            self.scripts.append({"attributes": attributes, "text": []})
        for name in ID_REFERENCE_ATTRIBUTES:
            self.references.extend((attributes.get(name) or "").split())
        if tag not in VOID_ELEMENTS:
            self.stack.append(element)

    def handle_data(self, text):
        if self.stack and self.stack[-1].tag == "script":
            self.scripts[-1]["text"].append(text)

    def handle_startendtag(self, tag, attributes):
        self.handle_starttag(tag, attributes)
        if tag not in VOID_ELEMENTS:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        line = self.getpos()[0]
        require(self.stack, f"Unexpected </{tag}> at line {line}")
        opened = self.stack[-1]
        require(
            opened.tag == tag,
            f"Closing </{tag}> at line {line}, but <{opened.tag}> from line {opened.line} is open",
        )
        self.stack.pop()


def find_site(requested=None):
    """Locate a unique entry point without assuming the publishing directory."""
    if requested is not None:
        site = (PROJECT_ROOT / requested).resolve()
        require((site / "index.html").is_file(), f"Missing index.html in {site}")
        return site

    candidates = (PROJECT_ROOT, PROJECT_ROOT / "site")
    available = [path for path in candidates if (path / "index.html").is_file()]
    require(available, "Missing index.html: checked the repository root and site/.")
    require(
        len(available) == 1,
        "Multiple entry points found. Use --site site or --site . to select the published directory.",
    )
    return available[0]


def local_asset(site, reference, base=None):
    """Resolve a local URL and require its decoded path to stay inside the site.

    HTML and fetch URLs use the document directory. Module and import.meta.url
    references use the containing JavaScript directory supplied as base.
    External URLs are left to the browser and return None.
    """
    parts = urlsplit(reference)
    if parts.scheme or parts.netloc or not parts.path:
        return None
    decoded = unquote(parts.path)
    require(not decoded.startswith("/"), f"Use repository-relative asset paths: {reference}")
    asset = ((base or site) / decoded).resolve()
    require(asset.is_relative_to(site.resolve()), f"Asset leaves the site directory: {reference}")
    require(asset.is_file(), f"Missing local asset: {reference} (resolved to {asset})")
    return asset


def validate_html(site):
    """Check the section container, stable IDs and external executable scripts."""
    parser = Structure()
    parser.feed((site / "index.html").read_text(encoding="utf-8"))
    parser.close()
    require(not parser.stack, "HTML has unclosed elements")
    require(parser.language == "en", 'Declare the interface language with lang="en".')
    require("dataset" not in parser.ids, "Keep research data in data/corpus.json, outside the HTML.")

    for name in RESEARCH_SECTIONS:
        require(name in parser.sections, f"Missing research section: {name}")
    wrappers = [parser.sections[name] for name in RESEARCH_SECTIONS]
    require(all(len(entries) == 1 for entries in wrappers), "Each research section needs its shared container.")
    require(all(entries == wrappers[0] for entries in wrappers), "Research sections no longer share the same centred container.")
    for target in parser.references:
        require(target in parser.ids, f"Missing label or ARIA target: {target}")

    executable = 0
    for script in parser.scripts:
        attributes = script["attributes"]
        script_type = (attributes.get("type") or "").strip().lower()
        if script_type in JSON_SCRIPT_TYPES:
            if not attributes.get("src"):
                json.loads("".join(script["text"]))
            continue
        executable += 1
        require(attributes.get("src"), "Executable JavaScript must be in an external file.")
    require(executable, "Missing external application script.")
    return parser


def validate_links(site, structure):
    """Check local resources and fragment targets without making network requests."""
    for reference in structure.links:
        parts = urlsplit(reference)
        if parts.scheme or parts.netloc:
            continue
        asset = local_asset(site, reference)
        fragment = unquote(parts.fragment)
        if not fragment:
            continue
        if asset is None or asset == site / "index.html":
            require(fragment in structure.ids, f"Broken fragment: {reference}")
        elif asset.suffix.lower() == ".svg":
            svg = ElementTree.parse(asset)
            require(any(node.get("id") == fragment for node in svg.iter()), f"Missing SVG symbol: {reference}")
    for asset in (site / "assets/icons").rglob("*.svg"):
        ElementTree.parse(asset)


def validate_javascript(site, structure):
    """Check literal dependencies and compile syntax with the installed Node.js."""
    node = shutil.which("node")
    require(node, "Node.js is required for syntax checks. The node command was not found in PATH.")
    scripts = {
        asset for script in structure.scripts
        if script["attributes"].get("src")
        and (script["attributes"].get("type") or "").strip().lower() not in JSON_SCRIPT_TYPES
        and (asset := local_asset(site, script["attributes"]["src"])) is not None
    }
    scripts.update((site / "assets/js").rglob("*.js"))
    scripts.update((site / "assets/js").rglob("*.mjs"))
    for path in sorted(scripts):
        code = path.read_text(encoding="utf-8")
        for _, identifier in JS_ELEMENT_REFERENCE.findall(code):
            require(identifier in structure.ids, f"{path.name} references a missing element: {identifier}")
        for pattern in (JS_MODULE_REFERENCE, JS_DATA_REFERENCE):
            for reference in pattern.findall(code):
                local_asset(site, reference, base=path.parent)
        for reference in JS_FETCH_REFERENCE.findall(code):
            local_asset(site, reference)
        result = subprocess.run(
            [node, "--check", str(path)], capture_output=True, text=True, timeout=30, check=False
        )
        require(result.returncode == 0, f"JavaScript syntax error in {path.name}:\n{result.stderr.strip()}")


def read_object(path):
    """Read a JSON object and report its filename when the shape is unexpected."""
    data = json.loads(path.read_bytes())
    require(isinstance(data, dict), f"Expected a JSON object in {path}")
    return data


def require_fields(value, names, label):
    require(isinstance(value, dict), f"Expected an object for {label}")
    missing = [name for name in names if name not in value]
    require(not missing, f"Missing fields in {label}: {', '.join(missing)}")


def validate_dataset(site):
    """Check supplied records and assignment consistency without changing values."""
    path = site / "data/corpus.json"
    data = read_object(path)
    require_fields(data, ("docs", "solutions", "seedMetrics", "localSeeds", "subtopics", "names", "provenance"), "corpus")
    for name in ("docs", "seedMetrics", "localSeeds", "subtopics"):
        require(isinstance(data[name], list), f"Expected an array for corpus.{name}")
    require(data["docs"], "The corpus contains no mapped articles.")
    require_fields(data["solutions"], (DEFAULT_SOLUTION,), "solutions")
    require_fields(data["names"], ("parent_names", "subtopic_names"), "topic names")
    require_fields(data["provenance"], ("corpus_articles", "coordinate_sha256"), "provenance")
    for name in ("parent_names", "subtopic_names"):
        require(isinstance(data["names"][name], dict), f"Expected an object for names.{name}")

    pmids = set()
    for index, record in enumerate(data["docs"]):
        require_fields(record, ("PMID", "Title", "UMAP1", "UMAP2", "parent_group"), f"article {index}")
        pmid = str(record["PMID"])
        require(record["PMID"] and pmid not in pmids, f"Missing or duplicate mapped PMID: {pmid}")
        pmids.add(pmid)
        require(isinstance(record["Title"], str), f"Invalid title for PMID {pmid}")
        for name in ("UMAP1", "UMAP2"):
            value = record[name]
            try:
                valid = not isinstance(value, bool) and value not in (None, "") and math.isfinite(float(value))
            except (TypeError, ValueError, OverflowError):
                valid = False
            require(valid, f"Invalid {name} coordinate for PMID {pmid}")
        require(str(record["parent_group"]) in data["names"]["parent_names"], f"Unnamed parent group for PMID {pmid}")
        if record.get("subtopic_id"):
            require(str(record["subtopic_id"]) in data["names"]["subtopic_names"], f"Unnamed subtopic for PMID {pmid}")

    for name, solution in data["solutions"].items():
        require_fields(solution, ("labels",), f"solution {name}")
        labels = solution["labels"]
        require(isinstance(labels, list) and len(labels) == len(data["docs"]), f"Assignment length mismatch: {name}")
    return data


def validate_manifest(site, data):
    """Require the original byte-level SHA-256 and its declared corpus counts.

    A formatting-only change to corpus.json also changes this hash. The validator
    reports the mismatch and never updates the manifest automatically.
    """
    manifest_path = site / "data/manifest.json"
    require(manifest_path.is_file(), f"Missing dataset integrity manifest: {manifest_path}")
    manifest = read_object(manifest_path)
    expected = {
        "sha256": hashlib.sha256((site / "data/corpus.json").read_bytes()).hexdigest(),
        "mapped_articles": len(data["docs"]),
        "global_solutions": len(data["solutions"]),
        "global_runs": len(data["seedMetrics"]),
        "local_runs": len(data["localSeeds"]),
        "broad_groups": len(data["names"]["parent_names"]),
        "local_subtopics": len(data["subtopics"]),
        "corpus_articles": data["provenance"]["corpus_articles"],
        "coordinate_sha256": data["provenance"]["coordinate_sha256"],
    }
    require_fields(manifest, expected, "manifest")
    require(manifest["sha256"] == expected["sha256"], "Research data changed: SHA-256 differs from the manifest. Review the change before updating the manifest intentionally.")
    for name, value in expected.items():
        require(manifest[name] == value, f"Manifest mismatch: {name}")


def validate_presentation(site):
    """Guard the layout choices and removed dependency agreed for this viewer."""
    css = (site / "assets/css/styles.css").read_text(encoding="utf-8")
    css = re.sub(r"/\*[\s\S]*?\*/", "", css)
    checks = (
        (r"\.nav-inner\s*\{[^}]*justify-content:\s*center", "Top navigation is no longer centred."),
        (r"\.back-to-top\s*\{[^}]*position:\s*fixed", "Return-to-top link must stay fixed."),
        (r"(?:^|\})\s*html\s*\{[^}]*scroll-behavior:\s*auto", "Keep global scrolling instant to avoid animation on reload."),
    )
    for pattern, message in checks:
        require(re.search(pattern, css), message)
    code = (site / "assets/js/app.js").read_text(encoding="utf-8")
    require("inspectorIcon" not in code, "The removed decorative icon must not be required by the viewer.")


def main(argv=None):
    arguments = argparse.ArgumentParser(description=__doc__)
    arguments.add_argument("--site", type=Path, help="Website directory, relative to the repository root or absolute.")
    site = find_site(arguments.parse_args(argv).site)
    print(f"Checking: {site}")
    structure = validate_html(site)
    validate_links(site, structure)
    print("PASS: HTML structure, shared container, IDs, references and SVG assets")
    validate_javascript(site, structure)
    print("PASS: external JavaScript, literal dependencies and Node.js syntax checks")
    data = validate_dataset(site)
    validate_manifest(site, data)
    print("PASS: dataset consistency, manifest counts and corpus SHA-256")
    validate_presentation(site)
    print("PASS: centred navigation, fixed return-to-top link and instant scrolling")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValidationError, OSError, ValueError, ElementTree.ParseError, subprocess.TimeoutExpired) as error:
        print(f"FAIL: {error}", file=sys.stderr)
        sys.exit(1)
