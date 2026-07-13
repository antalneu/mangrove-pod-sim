"""
mangrovesim - root-growth pressure simulation on a real mangrove seed-pod mesh.

Modules
-------
podmesh      Load the Rhino .3dm pod, extract a triangle mesh, detect features
             (waist, vertical slots, base feet, wall-thickness field, inner wall).
perforation  Parametric perforation pattern (waist slots + base split lines) that
             produces a per-face wall-strength / weakness field. Lets you test
             variations of slot length/width/spacing and base split geometry.
growth       Branching root-system growth (space-colonization) inside the cavity,
             seeded near the top opening, biased downward + outward toward the
             existing slots and the base splits.
pressure     Maps expanding-root contact into outward pressure on the inner wall,
             accumulates stress per face over time, and decides failure using the
             perforation weakness field. Detects the first "breakthrough".
montecarlo   Runs many randomised growth simulations and aggregates statistics
             (mean breakthrough time, which split points activate first, spread).
viz          Matplotlib static renders + Plotly interactive 3-D pressure heatmaps.
"""
from .podmesh import PodMesh

__all__ = ["PodMesh"]
