const galleryData = {
  artwork: [
    {
      title: "The Lechon",
      credit: "<i>The Lechon</i>, Glae Alejo (September 2024) Mixed media (oil pastel on paper, watercolour and ink on paper), HLSS.",
      flavour: "Filipino flavour",
      description: `<h3>What is the story behind the centre panel you have created?</h4>
<p>The story behind my centre panel for this artwork is my memory of preparing and eating lechon in the Philippines back in December 2016. I helped prepare and cook the pig with my family for dinner—it was the tastiest lechon I ever ate. I chose to depict this scene because I thought it a great example of the pillars of my Filipino culture—family and food.</p>
<h3>Reflect on the strength of your overall composition by referring to how you used some of the elements and principles of design in your work.</h4>
<p>I think I had a strong composition for the centrepiece. There is a strong complementary orange-blue colour scheme highlighting the lechon as the focal point. The outer quilt pieces have a similar colour to this end. Also contributing to this focus is the movement and rhythm of the oil pastel strokes emphasising the presence of the cooked pig. Finally, I paid attention to the rule of thirds (sky at the top, lechon in the middle, ashes at the bottom) to reinforce the composition.</p>
<h3>Why do you think we created the quilt pieces as a full group instead of each student making their own patches? Reflect on whether you believe this strengthened or weakened your final artwork.</h4>
<p>We created the quilt outer pieces as a group to add a unique and collaborative touch to the project. Different people creating each small patch allows for more variety in how each quilt turns out. If individuals made their own quilt patches, it would lose that element of community that highlights the culture and individuality of the centrepiece. Having other people contribute to the quilt patches reinforced my work, adding more visual interest.</p>
      `,
      image: "img/story_quilt.jpg"
    },
    {
      title: "Artwork 2", 
      credit: "Traditional Art, 2023",
      flavour: "Placeholder text",
      description: "Description of artwork 2. This is a placeholder text that describes the artwork in detail.",
      image: "https://placehold.co/300x400"
    },
    {
      title: "Artwork 3",
      credit: "Mixed Media, 2024",
      flavour: "Placeholder text",
      description: "Description of artwork 3. This is a placeholder text that describes the artwork in detail.",
      image: "https://placehold.co/1000x500"
    },
    {
      title: "Artwork 4",
      credit: "Digital Art, 2023",
      flavour: "Placeholder text",
      description: "Description of artwork 4. This is a placeholder text that describes the artwork in detail.",
      image: "https://placehold.co/400"
    },
    {
      title: "Artwork 5",
      credit: "Digital Art, 2024",
      flavour: "Placeholder text",
      description: "Description of artwork 5. This is a placeholder text that describes the artwork in detail.",
      image: "https://placehold.co/400"
    }
  ],
};

const modal = document.getElementById('artwork-modal');
const closeButton = modal.querySelector('.close-button');

function openModal(title, credit, flavour, content, image) {
  modal.querySelector('.modal-title').textContent = title;
  modal.querySelector('.modal-credit').textContent = flavour;
  modal.querySelector('.modal-body').innerHTML = content;

  const modalImage = modal.querySelector('.modal-image');
  const img = document.createElement('img');
  img.src = image;
  img.alt = title;
  img.loading = 'lazy';
  img.onload = () => {
    const aspectRatio = img.width / img.height;
    const modalContent = modal.querySelector('.modal-content');
    if (aspectRatio > 1.5) {
      modalContent.style.gridTemplateColumns = '1fr';
      modalContent.style.gridGap = '0';
      modalImage.style.gridColumn = '1';
      modalImage.style.order = '-1';
    } else {
      modalContent.style.gridTemplateColumns = '';
      modalContent.style.gridGap = '';
      modalImage.style.gridColumn = '';
      modalImage.style.order = '';
    }
  };
  const figcaption = document.createElement('figcaption');
  figcaption.innerHTML = credit;

  modalImage.innerHTML = '';

  modalImage.appendChild(img);
  modalImage.appendChild(figcaption);
  modal.classList.add('active');
  document.body.style.overflow = 'hidden';
}

function closeModal() {
  modal.classList.remove('active');
  document.body.style.overflow = '';
}

// Close modal when clicking close button
closeButton.addEventListener('click', closeModal);

// Close modal when clicking outside
modal.addEventListener('click', (e) => {
  if (e.target === modal) closeModal();
});

// Close modal with Escape key
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && modal.classList.contains('active')) {
    closeModal();
  }
});

document.querySelectorAll('.gallery-item .button').forEach(button => {
  button.addEventListener('click', (e) => {
    e.preventDefault();
    const title = e.target.textContent;

    const artworkData = galleryData.artwork.find(item => item.title === title);
    if (artworkData) {
      openModal(
        artworkData.title,
        artworkData.credit,
        artworkData.flavour,
        artworkData.description,
        artworkData.image
      );
    }
  });
});