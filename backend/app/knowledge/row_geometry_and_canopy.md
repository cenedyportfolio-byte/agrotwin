# Row geometry and canopy closure

## What the row measurements mean
From an RGB orthomosaic AgroTwin measures the crop rows' direction (a compass
bearing) and their spacing. Soybeans are commonly planted in 15-inch (38 cm),
20-inch (51 cm) or 30-inch (76 cm) rows, and drilled at 7.5 inches (19 cm).
A measured spacing that does not match the planter setting usually means the
rows could not be resolved (closed canopy, blur) rather than a planter fault.
The bearing lets you line the map up with sprayer and harvester passes, and
straight, evenly spaced rows are also what makes gap detection reliable.

## Canopy closure percentage
The canopy closure figure is the share of the ground between rows that is
covered by leaves, measured on the part of the field where rows could be
followed. Below about 35 % the rows are clearly separate and vegetation
between them is not crop; between 35 % and about 80 % the rows are still
visible but neighbouring plants reach into the inter-row; above 80 % the
canopy has effectively closed. Narrow rows and vigorous stands close early,
which shades out late-emerging weeds and conserves soil moisture, so early
closure is generally good news for the crop.

## Why weed candidates need an open canopy
Inter-row weed mapping counts vegetation that grows where the crop was not
planted. Once the canopy closes that space is crop, and any method that
flagged it would be reporting the soybeans as weeds. AgroTwin therefore only
produces weed candidates while the mid-row cover is low enough for rows to be
separable, and otherwise says that the canopy is closed. For weed mapping,
fly the field early (about V2 to V4); for late-season escapes look for weeds
standing above the canopy, which needs either a later flight with 3D
reconstruction or a scout.
