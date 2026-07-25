"""
mangrovesim - root-growth pressure simulation on a real mangrove seed-pod mesh.

Modules
-------
podmesh      Load the Rhino .3dm pod, extract a triangle mesh, detect features
             (waist, vertical slots, base feet, wall-thickness field, inner wall).
perforation  Parametric perforation pattern (waist slots + base split lines) that
             produces the per-face net scored section (t_eff, bending span, bore
             radius). Lets you test variations of slot length/width/spacing,
             base split geometry, and seam scoring depth.
growth       Branching root-system growth (space-colonization) inside the cavity,
             seeded near the top opening, biased downward + outward toward the
             existing slots and the base splits.
pressure     Maps expanding-root contact into a turgor-bounded bearing pressure,
             converts it to a real wall stress in MPa (hoop + plate bending on
             the net scored section), and fails the wall by brittle overload or
             static fatigue. Detects the first "breakthrough".
montecarlo   Runs many randomised simulations - resampling root architecture,
             fracture strength, root pressure and wall tolerance - and aggregates
             a real release probability plus the stress spread behind it.
viz          Matplotlib static renders + Plotly interactive 3-D stress heatmaps.

The wall mechanics here are the same model the browser tool in docs/ runs, so
the offline renders and the website agree. See "How the failure model works" in
README.md.
"""
from .podmesh import PodMesh

__all__ = ["PodMesh"]
