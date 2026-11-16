# PROTOTYPE (wayfinder #382), throwaway: inline dist/ into one Artifact page
# (title, style, root, script; the Artifact host adds the skeleton).
import pathlib, re, sys
d = pathlib.Path(__file__).parent / "dist"
html = (d / "index.html").read_text()
css = "".join((d / m).read_text() for m in re.findall(r'href="\./([^"]+\.css)"', html))
js = "".join((d / m).read_text() for m in re.findall(r'src="\./([^"]+\.js)"', html)).replace("</script", "<\\/script")
page = f"""<title>Holding Bars Prototype</title>
<style>{css}
:root {{ color-scheme: dark; }}
</style>
<script>document.documentElement.classList.add("dark")</script>
<div id="root"></div>
<script type="module">{js}</script>
"""
pathlib.Path(sys.argv[1]).write_text(page)
