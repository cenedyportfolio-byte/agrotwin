# Reading AgroTwin results

## Healthy, needs attention and problem tiers
AgroTwin measures vegetation cover from the survey's own pixels: NDVI when
multispectral bands exist, the RGB Excess Green Index otherwise. With a
georeferenced map the field is measured in 5 m cells (true area shares);
without one, one measurement per photo. Each cell is compared with the cover
the field's own best-developed ground reaches (its 90th percentile): at least
80 % of that reference counts as healthy, 50 to 80 % as needs attention, below
50 % as a problem area. Because the reference adapts to the field and growth
stage, a uniform field reads healthy even early in the season, and the tiers
of two different surveys are only loosely comparable. The method used is
labelled on every result.

## What a flagged zone is and is not
A zone is an area of measurably lower vegetation cover than the rest of the
field, merged from neighbouring flagged cells. Its type describes what was
measured: bare soil (almost no vegetation), low crop density (thin stand) or
patchy vegetation (uneven cover). A zone is never a diagnosis: the imagery
shows where the crop is thinner, not why. The recommended actions are
deliberately conservative: inspect, compare with the previous survey, ground
inspection recommended. AgroTwin does not recommend pesticides or other
treatments.

## Weed candidates and trained detectors
Weed candidates come from crop-row analysis on the orthomosaic: rows are
located from their regular spacing, and vegetation growing between rows is
flagged for scouting. This only works while the canopy is open enough for
rows to be separable; once the canopy has closed the space between rows is
crop, and AgroTwin reports that no candidates could be measured rather than
guessing. Species are never identified from the drone image. Identifying
weed species, disease or pests needs a trained detector model, which in turn
needs labelled imagery of this crop; until such a model is installed the
analysis is a measured vegetation index, and the app says so.

## Comparing surveys over time
The most useful comparison is the same field flown at similar times of day and
growth stages, with the same camera and altitude. Then a zone that persists
across flights points at a fixed cause (drainage, compaction, soil type,
nematodes), while a zone that appears suddenly points at a recent event
(insects, disease, herbicide injury, wind or hail). Different measurement
methods between surveys (per-photo versus map, RGB versus NDVI) make the
numbers a rough trend rather than a like-for-like change.
