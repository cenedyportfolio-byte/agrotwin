# Vegetation indices explained

## NDVI (Normalized Difference Vegetation Index)
NDVI = (NIR − Red) / (NIR + Red), computed from the near-infrared and red
bands of a multispectral camera. Healthy leaves reflect strongly in NIR and
absorb red light for photosynthesis, so dense healthy canopy gives high values.
Typical ranges: bare soil about 0.1 to 0.2, sparse or emerging crop 0.2 to
0.4, dense healthy canopy 0.6 to 0.9. NDVI saturates once the canopy is dense
(high leaf area), so late-season differences between good and very good crop
can look identical. Compare NDVI only between flights made under similar light
and at similar growth stages, and treat it as relative within a field rather
than an absolute health score.

## NDRE (Normalized Difference Red Edge)
NDRE = (NIR − RedEdge) / (NIR + RedEdge). The red-edge band sits between red
and NIR where reflectance rises steeply with chlorophyll content. NDRE is less
prone to saturation than NDVI in a closed canopy and responds to chlorophyll
and nitrogen status, which makes it more useful from mid-season onward.
Healthy mid-season canopy typically reads about 0.2 to 0.6; values are lower
than NDVI for the same crop, so the two must not be compared directly.

## GNDVI (Green NDVI)
GNDVI = (NIR − Green) / (NIR + Green). It uses the green band instead of red
and is more sensitive to chlorophyll concentration and to variation in dense
canopies than NDVI. Like NDRE it is useful for spotting relative differences
in vigour or nutrient status across a field once the canopy is well developed.

## Excess Green Index (ExG) for RGB cameras
ExG = 2·g − r − b, computed on chromaticity coordinates (each colour divided
by the sum of red, green and blue) so that exposure and lighting differences
cancel out. It separates green vegetation from soil, residue and shadow using
visible light only, which is why it works with a standard RGB drone camera.
Pixels above a small positive threshold (about 0.02 to 0.05) are counted as
vegetation. ExG measures greenness and cover; it cannot see the near-infrared
response that reveals stress before leaves visibly change colour, and it is
affected by deep shadows, wet soil and non-crop green material. Cover
measured with ExG is comparable only between flights with similar lighting
and growth stage.

## Limits shared by all indices
An index describes how much and how green the vegetation is; it does not say
why. A low value can come from a thin stand, drought, ponding, compaction,
nutrient deficiency, insect feeding, disease, weeds or a planter skip. Soil
colour, shadows, sun angle and camera calibration all shift values, so the
patterns within one flight are far more reliable than absolute numbers across
flights. Ground inspection is the step that turns a pattern into a cause.
