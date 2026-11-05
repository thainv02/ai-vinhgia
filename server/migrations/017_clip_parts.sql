-- 017_clip_parts: clip ghép nhiều đoạn (montage). JSON [{start_word,end_word,start_s,end_s,start_sentence,end_sentence}] theo THỨ TỰ PHÁT;
-- NULL = clip một đoạn như cũ. Khi có parts, start_*/end_* của dòng là khung bao (nhỏ nhất/lớn nhất) của các đoạn. Xem server/src/lib/clip-parts.ts.
ALTER TABLE clips ADD COLUMN parts TEXT;
