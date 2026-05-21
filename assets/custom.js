bundleQty();
slideImage();

window.addEventListener('load', function(){
  bundleQtyInit();
  filterFloating();
  wdStories();
  wdBanner();
})

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
