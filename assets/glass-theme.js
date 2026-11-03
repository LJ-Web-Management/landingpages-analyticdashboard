/* Liquid Glass theme controller — background layer + Appearance panel.
   Include with: <link rel="stylesheet" href="assets/glass.css"><script src="assets/glass-theme.js"></script>
   Exposes window.GlassTheme.onChange(fn) so pages can repaint charts when the tone flips. */
(function(){
  "use strict";
  var KEY = "glassTheme.v1";
  var PRESETS = [
    { id: "aurora", name: "Aurora", tone: "dark" },
    { id: "sunset", name: "Sunset", tone: "dark" },
    { id: "pearl",  name: "Pearl",  tone: "light" },
    { id: "solid",  name: "Solid",  tone: null }
  ];
  var defaults = { bg: "aurora", solid: "#2b4c7e", blur: 22 };
  var settings = load();
  var listeners = [];
  var root = document.documentElement;
  root.classList.add("glass");

  function load(){
    try { var s = JSON.parse(localStorage.getItem(KEY) || "null"); if (s && s.bg) return Object.assign({}, defaults, s); } catch(e){}
    return Object.assign({}, defaults);
  }
  function save(){ try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch(e){} }

  /* ---------- colour helpers ---------- */
  function clamp(v,a,b){ return Math.min(b, Math.max(a, v)); }
  function hexToRgb(hex){
    var m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex).trim()); if (!m) return null;
    var h = m[1]; if (h.length === 3) h = h.split("").map(function(c){ return c+c; }).join("");
    return { r: parseInt(h.slice(0,2),16), g: parseInt(h.slice(2,4),16), b: parseInt(h.slice(4,6),16) };
  }
  function rgbToHex(r,g,b){ return "#" + [r,g,b].map(function(v){ return ("0" + Math.round(clamp(v,0,255)).toString(16)).slice(-2); }).join(""); }
  function hsvToRgb(h,s,v){
    var c = v*s, x = c*(1 - Math.abs((h/60)%2 - 1)), m = v - c, r=0,g=0,b=0;
    if (h<60){r=c;g=x;} else if (h<120){r=x;g=c;} else if (h<180){g=c;b=x;} else if (h<240){g=x;b=c;} else if (h<300){r=x;b=c;} else {r=c;b=x;}
    return { r:(r+m)*255, g:(g+m)*255, b:(b+m)*255 };
  }
  function rgbToHsv(r,g,b){
    r/=255; g/=255; b/=255;
    var max=Math.max(r,g,b), min=Math.min(r,g,b), d=max-min, h=0;
    if (d){ if (max===r) h=((g-b)/d)%6; else if (max===g) h=(b-r)/d+2; else h=(r-g)/d+4; h*=60; if (h<0) h+=360; }
    return { h:h, s: max ? d/max : 0, v: max };
  }
  function luminance(rgb){
    function ch(c){ c/=255; return c <= 0.03928 ? c/12.92 : Math.pow((c+0.055)/1.055, 2.4); }
    return 0.2126*ch(rgb.r) + 0.7152*ch(rgb.g) + 0.0722*ch(rgb.b);
  }

  /* ---------- background layer ---------- */
  var bg = document.createElement("div");
  bg.id = "glass-bg"; bg.setAttribute("aria-hidden", "true");
  bg.innerHTML = '<div class="blob b1"></div><div class="blob b2"></div><div class="blob b3"></div><div class="blob b4"></div><div class="grain"></div>';

  function currentTone(){
    if (settings.bg !== "solid") return PRESETS.filter(function(p){ return p.id === settings.bg; })[0].tone;
    var rgb = hexToRgb(settings.solid) || {r:0,g:0,b:0};
    return luminance(rgb) > 0.36 ? "light" : "dark";
  }
  function apply(){
    bg.setAttribute("data-bg", settings.bg);
    bg.style.setProperty("--bg-solid", settings.solid);
    if (settings.bg === "solid"){
      // a soft vignette keeps glass edges readable on flat colour
      bg.style.background = "radial-gradient(120% 90% at 30% 0%, rgba(255,255,255,0.16), transparent 60%), radial-gradient(100% 80% at 100% 100%, rgba(0,0,0,0.22), transparent 60%), " + settings.solid;
    } else bg.style.background = "";
    var tone = currentTone();
    var changed = root.getAttribute("data-tone") !== tone;
    root.setAttribute("data-tone", tone);
    root.style.setProperty("--glass-blur", settings.blur + "px");
    var meta = document.querySelector('meta[name="theme-color"]');
    if (!meta){ meta = document.createElement("meta"); meta.name = "theme-color"; document.head.appendChild(meta); }
    meta.content = settings.bg === "solid" ? settings.solid : ({aurora:"#0a0c1f", sunset:"#6b1d4f", pearl:"#f4f1ff"})[settings.bg];
    listeners.forEach(function(fn){ try { fn({ tone: tone, toneChanged: changed, settings: settings }); } catch(e){ console.error(e); } });
  }

  /* ---------- Appearance panel ---------- */
  var PALETTE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22a10 10 0 1 1 10-10c0 2.8-2.2 4-4 4h-2a2 2 0 0 0-1.5 3.3A2 2 0 0 1 12 22z"/><circle cx="7.5" cy="10.5" r="1.3"/><circle cx="12" cy="7" r="1.3"/><circle cx="16.5" cy="10.5" r="1.3"/></svg>';
  var QUICK = ["#0b1020","#1f2a44","#2b4c7e","#0f5257","#3b1f4f","#7a1f3d","#e8e4dc","#f7f7f9"];

  function buildPanel(){
    var fab = document.createElement("button");
    fab.className = "glass-btn appearance-fab"; fab.type = "button";
    fab.setAttribute("aria-expanded", "false"); fab.setAttribute("aria-controls", "appearancePanel");
    fab.innerHTML = PALETTE_ICON + "<span>Appearance</span>";

    var panel = document.createElement("div");
    panel.id = "appearancePanel"; panel.className = "glass-panel appearance-panel";
    panel.setAttribute("role", "dialog"); panel.setAttribute("aria-label", "Appearance");
    panel.innerHTML =
      '<h3>Appearance</h3><p class="ap-sub">Liquid glass sits on top of the background you pick.</p>' +
      '<div class="ap-label">Background</div>' +
      '<div class="ap-presets">' + PRESETS.map(function(p){
        return '<button type="button" class="ap-preset" data-bg="' + p.id + '" aria-pressed="false"><span>' + p.name + '</span></button>';
      }).join("") + '</div>' +
      '<div class="ap-solid" id="apSolid">' +
        '<div class="ap-label">Solid colour</div>' +
        '<div class="ap-wheel-wrap" id="apWheel"><canvas width="440" height="440" aria-label="Colour wheel: hue and saturation"></canvas><div class="ap-wheel-dim"></div><div class="ap-handle"></div></div>' +
        '<input type="range" class="ap-slider" id="apBright" min="0" max="100" step="1" aria-label="Brightness">' +
        '<div class="ap-slider-labels"><span>Dark</span><span>Brightness</span><span>Bright</span></div>' +
        '<div class="ap-hex-row"><div class="ap-hex-swatch" id="apSwatch"></div><input class="ap-hex" id="apHex" spellcheck="false" maxlength="7" aria-label="Hex colour"></div>' +
        '<div class="ap-quick">' + QUICK.map(function(c){ return '<button type="button" data-c="' + c + '" style="background:' + c + '" aria-label="' + c + '"></button>'; }).join("") + '</div>' +
      '</div>' +
      '<div class="ap-label">Frost</div>' +
      '<div class="ap-range-row"><span>Clear</span><input type="range" id="apBlur" min="6" max="40" step="1" aria-label="Glass blur"><span>Frosted</span></div>';

    document.body.appendChild(panel);
    document.body.appendChild(fab);

    function toggle(open){
      if (open === undefined) open = !panel.classList.contains("open");
      panel.classList.toggle("open", open);
      fab.setAttribute("aria-expanded", String(open));
      if (open) drawWheel();
    }
    fab.addEventListener("click", function(e){ e.stopPropagation(); toggle(); });
    document.addEventListener("click", function(e){ if (panel.classList.contains("open") && !panel.contains(e.target) && e.target !== fab) toggle(false); });
    document.addEventListener("keydown", function(e){ if (e.key === "Escape" && panel.classList.contains("open")){ toggle(false); fab.focus(); } });

    var presetBtns = panel.querySelectorAll(".ap-preset");
    var solidBox = panel.querySelector("#apSolid");
    function syncPresets(){
      presetBtns.forEach(function(b){ b.setAttribute("aria-pressed", String(b.getAttribute("data-bg") === settings.bg)); });
      solidBox.classList.toggle("show", settings.bg === "solid");
    }
    presetBtns.forEach(function(b){
      b.addEventListener("click", function(){ settings.bg = b.getAttribute("data-bg"); save(); syncPresets(); apply(); if (settings.bg === "solid") drawWheel(); });
    });

    /* colour wheel (hue = angle, saturation = radius) + brightness slider */
    var wrap = panel.querySelector("#apWheel"), canvas = wrap.querySelector("canvas");
    var dim = wrap.querySelector(".ap-wheel-dim"), handle = wrap.querySelector(".ap-handle");
    var bright = panel.querySelector("#apBright"), hexIn = panel.querySelector("#apHex"), swatch = panel.querySelector("#apSwatch");
    var rgb0 = hexToRgb(settings.solid); var hsv = rgbToHsv(rgb0.r, rgb0.g, rgb0.b);
    var wheelDrawn = false;

    function drawWheel(){
      if (wheelDrawn) return; wheelDrawn = true;
      var ctx = canvas.getContext("2d"), size = canvas.width, r = size/2;
      var img = ctx.createImageData(size, size), d = img.data;
      for (var y=0; y<size; y++) for (var x=0; x<size; x++){
        var dx = x - r, dy = y - r, dist = Math.sqrt(dx*dx + dy*dy), i = (y*size + x)*4;
        if (dist > r){ d[i+3] = 0; continue; }
        var h = (Math.atan2(dy, dx) * 180/Math.PI + 360) % 360;
        var c = hsvToRgb(h, dist/r, 1);
        d[i]=c.r; d[i+1]=c.g; d[i+2]=c.b; d[i+3] = dist > r-1.5 ? 255*(r-dist)/1.5 : 255;
      }
      ctx.putImageData(img, 0, 0);
    }
    function syncSolidUI(){
      var c = hsvToRgb(hsv.h, hsv.s, hsv.v), hex = rgbToHex(c.r, c.g, c.b);
      var ang = hsv.h * Math.PI/180;
      handle.style.left = (50 + Math.cos(ang) * hsv.s * 50) + "%";
      handle.style.top  = (50 + Math.sin(ang) * hsv.s * 50) + "%";
      handle.style.background = hex;
      dim.style.opacity = String(1 - hsv.v);
      var full = hsvToRgb(hsv.h, hsv.s, 1);
      bright.style.background = "linear-gradient(90deg, #000, " + rgbToHex(full.r, full.g, full.b) + ")";
      bright.style.setProperty("--thumb", hex);
      bright.value = Math.round(hsv.v * 100);
      swatch.style.background = hex;
      if (document.activeElement !== hexIn) hexIn.value = hex;
      return hex;
    }
    var rafPending = false;
    function commit(){
      settings.solid = syncSolidUI();
      if (settings.bg !== "solid"){ settings.bg = "solid"; syncPresets(); }
      if (!rafPending){ rafPending = true; requestAnimationFrame(function(){ rafPending = false; apply(); save(); }); }
    }
    function pickAt(e){
      var rect = canvas.getBoundingClientRect();
      var dx = e.clientX - (rect.left + rect.width/2), dy = e.clientY - (rect.top + rect.height/2);
      var rr = rect.width/2;
      hsv.h = (Math.atan2(dy, dx) * 180/Math.PI + 360) % 360;
      hsv.s = clamp(Math.sqrt(dx*dx + dy*dy) / rr, 0, 1);
      if (hsv.v < 0.08) hsv.v = 0.5; // picking a hue on a black wheel would be invisible
      commit();
    }
    var dragging = false;
    canvas.addEventListener("pointerdown", function(e){ dragging = true; canvas.setPointerCapture(e.pointerId); pickAt(e); });
    canvas.addEventListener("pointermove", function(e){ if (dragging) pickAt(e); });
    canvas.addEventListener("pointerup", function(){ dragging = false; });
    canvas.addEventListener("pointercancel", function(){ dragging = false; });
    bright.addEventListener("input", function(){ hsv.v = bright.value/100; commit(); });
    hexIn.addEventListener("input", function(){
      var c = hexToRgb(hexIn.value); if (!c || hexIn.value.replace("#","").length < 6) return;
      hsv = rgbToHsv(c.r, c.g, c.b); commit();
    });
    hexIn.addEventListener("blur", syncSolidUI);
    panel.querySelectorAll(".ap-quick button").forEach(function(b){
      b.addEventListener("click", function(){ var c = hexToRgb(b.getAttribute("data-c")); hsv = rgbToHsv(c.r, c.g, c.b); commit(); });
    });

    var blur = panel.querySelector("#apBlur");
    blur.value = settings.blur;
    blur.addEventListener("input", function(){ settings.blur = Number(blur.value); root.style.setProperty("--glass-blur", settings.blur + "px"); save(); });

    syncPresets(); syncSolidUI();
  }

  function init(){
    document.body.insertBefore(bg, document.body.firstChild);
    apply();
    buildPanel();
  }
  // tone must be set before first paint to avoid a flash of the wrong text colour
  root.setAttribute("data-tone", currentTone());
  if (document.body) init(); else document.addEventListener("DOMContentLoaded", init);

  window.GlassTheme = {
    onChange: function(fn){ listeners.push(fn); },
    tone: currentTone,
    seriesColor: function(slot){ return getComputedStyle(root).getPropertyValue("--s" + slot).trim(); }
  };
})();
