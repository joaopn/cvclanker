# Working Nomads Extractor

Extractor wrapper around Working Nomads' JSON search API at `https://www.workingnomads.com/jobsapi/_search`.

## Notes

- Uses the public JSON API instead of scraping rendered HTML.
- Reuses the pipeline's existing search terms, country, and workplace type controls.
- Cities are ignored: the board's locations are country/region-level only, so a city
  filter matched nothing. Only the country tokens are sent.
- Working Nomads is a remote-only source, so hybrid and onsite-only runs are filtered out.
