bundleQty();
slideImage();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initProductCardGalleries);
} else {
  initProductCardGalleries();
}

window.addEventListener('load', function(){
  bundleQtyInit();
  filterFloating();
  wdStories();
  wdBanner();
})

// Prevent in-card gallery arrow events from bubbling to an outer <scroll-carousel>
// (e.g. featured-collection, related-products) which would otherwise also advance.
function initProductCardGalleries() {
  const scope = (el) => {
    if (el.__pcGalleryScoped) return;
    el.__pcGalleryScoped = true;
    el.addEventListener('control:prev', (e) => e.stopPropagation());
    el.addEventListener('control:next', (e) => e.stopPropagation());
    el.addEventListener('control:select', (e) => e.stopPropagation());
  };
  document.querySelectorAll('.product-card__gallery').forEach(scope);
  if (!window.MutationObserver) return;
  new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.matches && node.matches('.product-card__gallery')) scope(node);
        if (node.querySelectorAll) node.querySelectorAll('.product-card__gallery').forEach(scope);
      }
    }
  }).observe(document.body, { childList: true, subtree: true });
}

// =====================================================================
// B4B ("Bold - Variants Products") integration for collection product cards
// =====================================================================
// B4B clones a <product-card> in the browser per enabled variant and only
// rewrites the first <img> src. This leaves two issues:
//   1. Slides 2..n on a clone still show the parent variant's images, and
//      the color swatch row never marks the clone's variant as active.
//   2. Native prev-button/next-button resolve their target via aria-controls
//      + getElementById. Clones share the parent product.id, so all arrows
//      advance the first matching gallery.
//
// All behavior is gated on the presence of <script class="b4b-card-data">
// inside the card (only emitted by wd-collection-product-card.liquid), so
// other product-card snippets and unrelated carousels are untouched.

function getB4BCardData(card) {
  if (card.__b4bDataCache) return card.__b4bDataCache;
  const dataEl = card.querySelector('script.b4b-card-data');
  if (!dataEl) return null;
  try {
    card.__b4bDataCache = JSON.parse(dataEl.textContent);
    return card.__b4bDataCache;
  } catch (e) { return null; }
}

function applyB4BSlides(card, images) {
  const slides = card.querySelectorAll('.product-card__gallery .product-card__slide');
  if (!slides.length) return;
  slides.forEach((slide, i) => {
    const url = images && images[i];
    const img = slide.querySelector('img');
    if (url && img) {
      if (img.getAttribute('src') !== url) {
        img.src = url;
        img.removeAttribute('srcset');
      }
      slide.style.display = '';
    } else if (!url) {
      slide.style.display = 'none';
    }
  });
}

// B4B clones a card verbatim, so cloned swatch inputs share the same
// `name` and `id` as the original. Browsers enforce radio-group
// exclusivity by `name` across the whole document — so checking a swatch
// on the clone uncheckes the matching one on the original. Rewrite name
// and id (plus label `for`) to a per-card-unique suffix on first sight.
let b4bSwatchUid = 0;
function uniquifyB4BSwatchNames(card) {
  if (card.__b4bSwatchUniqued) return;
  const fieldset = card.querySelector('fieldset.product-card__swatch-list');
  if (!fieldset) return;
  card.__b4bSwatchUniqued = true;
  const suffix = '--b4b-' + (++b4bSwatchUid);
  fieldset.querySelectorAll('input[type="radio"]').forEach((inp) => {
    if (inp.name) inp.name = inp.name + suffix;
    if (inp.id) inp.id = inp.id + suffix;
  });
  fieldset.querySelectorAll('label[for]').forEach((lbl) => {
    const f = lbl.getAttribute('for');
    if (f) lbl.setAttribute('for', f + suffix);
  });
}

function applyB4BSwatch(card, color) {
  if (!color) return;
  const inputs = card.querySelectorAll('fieldset.product-card__swatch-list input[type="radio"]');
  inputs.forEach((inp) => {
    const should = inp.value === color;
    if (inp.checked !== should) inp.checked = should;
  });
}

function resolveB4BImages(map, color) {
  if (color && map.byColor && map.byColor[color] && map.byColor[color].length) {
    return map.byColor[color];
  }
  return (map.fallback && map.fallback.length) ? map.fallback : null;
}

// Rewrite every ?variant=… query param in this card's links so title
// click and slide click both navigate to the previewed variant. Scoped
// to the card so the original tile's links stay untouched.
function updateB4BCardVariantLinks(card, variantId) {
  if (!variantId) return;
  card.querySelectorAll('a[href*="variant="]').forEach((a) => {
    try {
      const url = new URL(a.getAttribute('href'), window.location.origin);
      url.searchParams.set('variant', variantId);
      a.setAttribute('href', url.pathname + url.search + url.hash);
    } catch (e) { /* malformed href — leave it */ }
  });
}

// Native prev-button / next-button bind their enable/disable scroll
// listeners via aria-controls + getElementById, which on a B4B clone
// resolves to the original tile's gallery (duplicate id). Result: the
// clone's Prev arrow starts `disabled` (from Liquid) and never gets
// re-enabled when scrolling the clone's own gallery, so it stays hidden.
// Bind a scoped scroll listener that toggles disabled on the in-card
// arrows based on the in-card gallery's actual scroll position.
// Click-and-drag scroll for the gallery on mouse devices. Touch devices
// already get native scroll-overflow swiping for free. We deliberately
// gate on (pointer: fine) so we don't double-handle on touch.
function enableB4BGalleryDrag(gallery) {
  if (gallery.__b4bDragEnabled) return;
  gallery.__b4bDragEnabled = true;
  let isDown = false, startX = 0, startScroll = 0, dragged = false;
  const onDown = (e) => {
    if (e.button !== 0) return;
    if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) return;
    isDown = true;
    dragged = false;
    startX = e.pageX;
    startScroll = gallery.scrollLeft;
    gallery.style.cursor = 'grabbing';
    gallery.style.userSelect = 'none';
  };
  const onMove = (e) => {
    if (!isDown) return;
    const dx = e.pageX - startX;
    if (Math.abs(dx) > 5) dragged = true;
    if (dragged) {
      e.preventDefault();
      gallery.scrollLeft = startScroll - dx;
    }
  };
  const onUp = () => {
    if (!isDown) return;
    isDown = false;
    gallery.style.cursor = '';
    gallery.style.userSelect = '';
    if (dragged) {
      // Block the synthetic click on the slide <a> that follows mouseup.
      const blocker = (ev) => { ev.preventDefault(); ev.stopPropagation(); };
      gallery.addEventListener('click', blocker, { capture: true, once: true });
    }
  };
  gallery.addEventListener('mousedown', onDown);
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
  // Cancel drag if mouse leaves the window
  window.addEventListener('mouseleave', onUp);
}

function rebindB4BArrowState(card) {
  if (card.__b4bArrowsRebound) return;
  const gallery = card.querySelector('.product-card__gallery');
  const prev = card.querySelector('.product-card__gallery-arrow--prev');
  const next = card.querySelector('.product-card__gallery-arrow--next');
  if (!gallery || (!prev && !next)) return;
  card.__b4bArrowsRebound = true;
  const update = () => {
    const sl = gallery.scrollLeft;
    const sw = gallery.scrollWidth;
    const cw = gallery.clientWidth;
    if (prev) prev.disabled = sl <= 1;
    if (next) next.disabled = sl + cw >= sw - 1;
  };
  gallery.addEventListener('scroll', update, { passive: true });
  if (window.requestAnimationFrame) requestAnimationFrame(update);
  else setTimeout(update, 0);
}

function applyB4BCardState(card) {
  if (!card || !card.getAttribute) return;
  const map = getB4BCardData(card);
  if (!map) return;
  uniquifyB4BSwatchNames(card);
  rebindB4BArrowState(card);
  const gallery = card.querySelector('.product-card__gallery');
  if (gallery) enableB4BGalleryDrag(gallery);
  const vid = card.getAttribute('data-variant-id');
  const color = vid && map.byVariant ? map.byVariant[vid] : null;
  const images = resolveB4BImages(map, color);
  if (images) applyB4BSlides(card, images);
  if (color) applyB4BSwatch(card, color);
}

function initB4BCards() {
  document.querySelectorAll('product-card').forEach(applyB4BCardState);

  if (!window.MutationObserver) return;
  new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === 'attributes') {
        if (m.target.matches && m.target.matches('product-card')) {
          applyB4BCardState(m.target);
        }
      } else if (m.type === 'childList') {
        m.addedNodes.forEach((n) => {
          if (n.nodeType !== 1) return;
          if (n.matches && n.matches('product-card')) applyB4BCardState(n);
          if (n.querySelectorAll) n.querySelectorAll('product-card').forEach(applyB4BCardState);
        });
      }
    }
  }).observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['data-variant-id'],
  });
}

// Capture-phase click router: scope arrow nav to the parent <product-card>
// so duplicate gallery IDs (B4B clones) don't all advance the first tile.
// Runs before the native prev-button/next-button click handler and
// short-circuits it via stopImmediatePropagation.
document.addEventListener('click', (e) => {
  const target = e.target;
  if (!target || !target.closest) return;
  const arrow = target.closest('.product-card__gallery-arrow--prev, .product-card__gallery-arrow--next');
  if (!arrow) return;
  const card = arrow.closest('product-card');
  const gallery = card && card.querySelector('.product-card__gallery');
  if (!gallery) return;
  e.stopImmediatePropagation();
  e.preventDefault();
  const evtName = arrow.classList.contains('product-card__gallery-arrow--prev')
    ? 'control:prev' : 'control:next';
  gallery.dispatchEvent(new CustomEvent(evtName, { bubbles: true, cancelable: true }));
}, true);

// Swatch click inside a B4B-aware card: preview the chosen color's images
// in this tile only. We deliberately do NOT mutate data-variant-id — that
// would trigger B4B's own variant-change handler, which paints its stale
// data-b4b-src URLs (only the first slide, in the wrong color) and snaps
// the carousel before our repaint lands, causing visible flicker. By
// repainting directly we stay invisible to B4B.
//
// We also reset the gallery scroll to slide 0 so the user always lands on
// the primary image of the newly selected color (instead of being stuck
// mid-swipe on what used to be slide 2 of the previous color).
document.addEventListener('change', (e) => {
  const input = e.target;
  if (!input || !input.matches) return;
  if (!input.matches('fieldset.product-card__swatch-list input[type="radio"]')) return;
  const card = input.closest('product-card');
  if (!card) return;
  const map = getB4BCardData(card);
  if (!map) return;
  const color = input.value;
  // Jump to slide 0 BEFORE swapping images so the user never sees a
  // mid-scroll animation of the previous slide position. Force 'instant'
  // because the gallery may have CSS scroll-behavior: smooth.
  const gallery = card.querySelector('.product-card__gallery');
  if (gallery) {
    const prevBehavior = gallery.style.scrollBehavior;
    gallery.style.scrollBehavior = 'auto';
    gallery.scrollLeft = 0;
    if (prevBehavior) gallery.style.scrollBehavior = prevBehavior;
    else gallery.style.removeProperty('scroll-behavior');
  }
  applyB4BSlides(card, resolveB4BImages(map, color));
  applyB4BSwatch(card, color);
  const newVid = map.colorToVariantId && map.colorToVariantId[color];
  if (newVid) updateB4BCardVariantLinks(card, newVid);
});

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initB4BCards);
} else {
  initB4BCards();
}

// Warm the browser cache for every color's images after page load, so
// swatch clicks swap instantly (no network fetch on first interaction).
// Done during idle time / after window load so it doesn't compete with
// initial render.
function preloadB4BCardImages() {
  document.querySelectorAll('product-card').forEach((card) => {
    if (card.__b4bImagesPreloaded) return;
    const map = getB4BCardData(card);
    if (!map || !map.byColor) return;
    card.__b4bImagesPreloaded = true;
    Object.keys(map.byColor).forEach((color) => {
      const urls = map.byColor[color];
      if (Array.isArray(urls)) {
        urls.forEach((u) => { if (u) { const i = new Image(); i.src = u; } });
      }
    });
  });
}

function scheduleB4BPreload() {
  if (window.requestIdleCallback) {
    window.requestIdleCallback(preloadB4BCardImages, { timeout: 2000 });
  } else {
    setTimeout(preloadB4BCardImages, 500);
  }
}

if (document.readyState === 'complete') {
  scheduleB4BPreload();
} else {
  window.addEventListener('load', scheduleB4BPreload);
}
function bundleQty() {
  const variants = document.querySelectorAll('.wd-disabled');
  if (variants.length > 0) {
    
    variants.forEach(e => {
      if (e.classList.contains('wd-disabled')) {
        e.classList.add("is-disabled");
      }
      const buy_buttons = document.querySelector('buy-buttons');
      e.addEventListener('click', function() {
        setTimeout(function(){
          const add_button = buy_buttons.querySelector('.button');
          const pay_button = buy_buttons.querySelector('.shopify-payment-button');
          add_button.disabled = true;
          add_button.classList.replace('button--secondary', 'button--subdued');
          add_button.firstElementChild.innerHTML =  window.themeVariables.strings.soldOutButton;
          pay_button ? pay_button.style.display = 'none' : null;
          document.querySelector('sold-out-badge').hidden = false;
        },20)
      })
    })
  }
}

function bundleQtyInit() {
  const selected = document.querySelector('[data-option-selector] input:checked');
  if (selected) {
    if (selected.nextElementSibling.classList.contains('wd-disabled')) {
      const buy_buttons = document.querySelector('buy-buttons');
      const add_button = buy_buttons.querySelector('.button');
      const pay_button = buy_buttons.querySelector('.shopify-payment-button');
        add_button.disabled = true;
        add_button.classList.replace('button--secondary', 'button--subdued');
        add_button.firstElementChild.innerHTML =  window.themeVariables.strings.soldOutButton;
        pay_button ? pay_button.style.display = 'none' : null;
        document.querySelector('sold-out-badge').hidden = false;    
    }
  }
  
}

function slideImage() {
  const containers = document.querySelectorAll('.wd-image-solo');
  if (containers.length > 0) {
    containers.forEach(e => {
      const container = e.querySelector('.wd-wrapper');
      const right = container.querySelector('.wd-slide');
      right.addEventListener('click', function() {
        const scrollAmount = 200; // Adjust the scroll amount as needed
        container.scrollLeft += scrollAmount;
      })
      
    })
  }
}

function filterFloating() {
  const filter = document.querySelector('.facets__floating-filter');
  if (filter) {
    const header = document.querySelector('header');
    const results = document.querySelector('.collection__results');
    const headerHeight = header.clientHeight;
    window.addEventListener('scroll', function() {
      var distanceFromTop = results.getBoundingClientRect().top;
      // console.log(distanceFromTop);
      if (distanceFromTop < headerHeight) {
        filter.classList.add("fixed");
        filter.style.top = headerHeight + 'px';
      } else if (distanceFromTop >= headerHeight) {
        filter.style.top = 0;
        filter.classList.remove("fixed");
      }
    })
    // const sortButton = filter.querySelector('button:last-child');
    // const filterButton = filter.querySelector('button:first-child');
    // sortButton.addEventListener('click', function() {
    //   console.log('works');
    //   setTimeout(function(){
    //     const aria = document.querySelector('facet-drawer #accordion-sort-by');
    //     console.log(aria);
    //     document.querySelector('facet-drawer').classList.remove('filter-by');
    //     document.querySelector('facet-drawer').classList.add('sort-by');
    //     aria.ariaExpanded = 'true';
    //     aria.setAttribute('open', true);
    //     const content = aria.querySelector('.accordion__content');
    //     content.style.opacity = '1';
    //     content.style.transform = 'translateY(-4px)';
    //   }, 200)
    // })
    // filterButton.addEventListener('click', function() {
    //   const aria = document.querySelector('facet-drawer #accordion-sort-by');
    //   document.querySelector('facet-drawer').classList.add('filter-by');
    //   document.querySelector('facet-drawer').classList.remove('sort-by');
    //   if (aria.getAttribute('open')) {
    //     aria.removeAttribute('open');
    //     aria.ariaExpanded = 'false';
    //   }
    // })
  }

  window.addEventListener('click', function(evt) {
    const sortBy = evt.target.classList.contains('button-sort-by');
    const filterBy =  evt.target.classList.contains('button-filter-by');
    if (sortBy && window.innerWidth < 768) {
      const aria = document.querySelector('facet-drawer #accordion-sort-by');
      document.querySelector('facet-drawer').classList.remove('filter-by');
      document.querySelector('facet-drawer').classList.add('sort-by');
      aria.ariaExpanded = 'true';
      aria.setAttribute('open', true);
      const content = aria.querySelector('.accordion__content');
      content.style.opacity = '1';
      content.style.transform = 'translateY(-4px)';
    }
    if (filterBy && window.innerWidth < 768) {
      const aria = document.querySelector('facet-drawer #accordion-sort-by');
      document.querySelector('facet-drawer').classList.add('filter-by');
      document.querySelector('facet-drawer').classList.remove('sort-by');
      if (aria.getAttribute('open')) {
        aria.removeAttribute('open');
        aria.ariaExpanded = 'false';
      }
    }
  })
}

function wdStories() {
  const block = document.querySelector('.wd-stories');
  if (block) {
    const buttons = block.querySelectorAll('.video-button');
    const icons = block.querySelectorAll('.wd-icon');
    const slides = block.querySelectorAll('swiper-slide');
    const progresses = block.querySelectorAll('.progress');
    const stories = block.querySelector('.stories');
    const overlay = block.querySelector('.overlay');
    const slider = block.querySelector('.videos');
    const next = block.querySelector('.prev-next-button--next');
    const prev = block.querySelector('.prev-next-button--prev');
    const mobilePrev = block.querySelector('.prev');
    const mobileNext = block.querySelector('.next');
    const mobileClose = block.querySelector('.mobile-close');
    const hdr = document.querySelector('header');
    const buySection = document.querySelector('product-quick-add');
    // buttons.forEach(e => {
    //   e.addEventListener('click', function(evt) {
    //     evt.preventDefault();
    //     const to = e.href.split('#').pop();
    //     const scrollTo = document.querySelector(`#${to}`);
    //     const ann = document.querySelector('.shopify-section--announcement-bar');
    //     const hdr = document.querySelector('.shopify-section--header');
    //     const bufferHeight = ann.clientHeight + hdr.clientHeight;
    //     document.querySelector('body').style.overflow = 'auto';
    //     stories.classList.remove('active');
    //     slides.forEach(slide => {
    //       slide.querySelector('video').pause();
    //     })
    //     window.scrollTo({
    //       top: scrollTo.offsetTop - bufferHeight,
    //       left: scrollTo.offsetLeft,
    //       behavior: "smooth",
    //     });
    //   })
    // })
    // close stories
    overlay.addEventListener('click', () => {
      document.querySelector('body').style.overflow = 'auto';
      stories.classList.remove('active');
      slides.forEach(slide => {
        slide.querySelector('video').pause();
      })
      hdr.style.zIndex = 10;
      buySection ? buySection.style.zIndex = 10 : null;
    })
    mobileClose.addEventListener('click', function() {
      document.querySelector('body').style.overflow = 'auto';
      stories.classList.remove('active');
      slides.forEach(slide => {
        slide.querySelector('video').pause();
      })
      hdr.style.zIndex = 10;
      buySection ? buySection.style.zIndex = 10 : null;
    })
    // icons click
    icons.forEach((icon, index) => {
      icon.addEventListener('click', () => {
        setTimeout(function() {
          stories.classList.add('active');
          document.querySelector('body').style.overflow = 'hidden';
          hdr.style.zIndex = 0;
          buySection ? buySection.style.zIndex = 0 : null;
        }, 200);
        slider.swiper.slideTo(index);
        swapSlides(slides, index);
      })
    })
    // slides change
    slider.addEventListener('swiperslidechange', function(event) {
      const index = event.detail[0].activeIndex;
      swapSlides(slides, index);
      
    })
    // swap slides function
    const swapSlides = (slides, index) => {
      slides.forEach((slide, idx) => {

        
        const video = slide.querySelector('video');
          const progress = progresses[idx].querySelector('.bar');
          if (idx < index) {
            video.pause();
            setTimeout(function(){progress.style.width = '100%'}, 100)
            // progress.style.width = '100%';
            // video.currentTime = video.duration;
          } else if (idx === index) {
            // console.log('here is a bug');
            video.currentTime = 0;
            video.play();
            video.addEventListener('timeupdate', () => {
              progress.style.width = (video.currentTime / video.duration) * 100 + '%';
            })
          } else {
            video.pause();
            video.currentTime = 0;
            progress.style.width = '0%';
          }
      })
    }
    // video end
    slides.forEach((slide, index) => {
      const video = slide.querySelector('video');
      if (index < slides.length) {
        video.addEventListener('timeupdate', () => {
          if (video.currentTime === video.duration) {
            slider.swiper.slideNext();
            // swapSlides(slides, index + 1);
          }
        })
      }
    })
    // navigation
    next.addEventListener('click', () => {
      slider.swiper.slideNext();
    })
    prev.addEventListener('click', () => {
      slider.swiper.slidePrev();
    })
    // mobileNext.addEventListener('click', () => {
    //   slider.swiper.slideNext();
    // })
    // mobilePrev.addEventListener('click', () => {
    //   slider.swiper.slidePrev();
    // })
  }
}

function wdBanner() {
  const blocks = document.querySelectorAll('.wd-banner');
  if (blocks.length > 0) {
    blocks.forEach(block => {
      const announce = document.querySelector('.announcement-bar')
      if (announce && window.innerWidth < 767) {
        block.querySelector('image-banner').style.height = `calc(100svh - 58px - ${announce.clientHeight}px)`;
      }
    })
  }
  const carousels = document.querySelectorAll('slideshow-carousel');
  carousels.forEach(carousel => {
    const announce = document.querySelector('.announcement-bar')
      if (announce && window.innerWidth < 767) {
        carousel.querySelectorAll('.content-over-media').forEach(e => {
          //e.style.height = `calc(100svh - 58px - ${announce.clientHeight}px)`;
        })
      }
  })
}
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.badge--primary').forEach(badge => {
    if (badge.textContent.trim().toUpperCase() === 'BEST DEAL') {
      badge.textContent = 'Best Deal';           // Fix capitalization
      badge.style.backgroundColor = '#45824C';   // Green background
      badge.style.color = '#ffffff';             // White text
      badge.style.border = '1px solid #052b1b';  // Dark-green border
    }
  });
});
