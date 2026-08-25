(import (scheme base) (scheme process-context) (scheme time))

(define (deriv form)
  (cond ((not (pair? form)) (if (eq? form 'x) 1 0))
        ((eq? (car form) '+) (cons '+ (map deriv (cdr form))))
        ((eq? (car form) '-) (cons '- (map deriv (cdr form))))
        ((eq? (car form) '*)
         (list '* form
               (cons '+
                     (map (lambda (factor) (list '/ (deriv factor) factor))
                          (cdr form)))))
        ((eq? (car form) '/)
         (list '-
               (list '/ (deriv (cadr form)) (caddr form))
               (list '/ (cadr form)
                     (list '* (caddr form) (caddr form) (deriv (caddr form))))))
        (else (error "No derivation method available" form))))

(define deriv-input '(+ (* 3 x x) (* a x x) (* b x) 5))
(define deriv-output
  '(+ (* (* 3 x x) (+ (/ 0 3) (/ 1 x) (/ 1 x)))
      (* (* a x x) (+ (/ 0 a) (/ 1 x) (/ 1 x)))
      (* (* b x) (+ (/ 0 b) (/ 1 x)))
      0))
(define (benchmark-deriv) (deriv deriv-input))

(define (create-n n)
  (let loop ((remaining n) (result '()))
    (if (= remaining 0)
        result
        (loop (- remaining 1) (cons '() result)))))

(define dividend (create-n 1000))
(define l18 (create-n 18))
(define l12 (create-n 12))
(define l6 (create-n 6))

(define (benchmark-diviter)
  (let loop ((values dividend) (result '()))
    (if (null? values)
        result
        (loop (cddr values) (cons (car values) result)))))

(define (divrec values)
  (if (null? values)
      '()
      (cons (car values) (divrec (cddr values)))))

(define (benchmark-divrec) (divrec dividend))

(define (tak x y z)
  (if (< y x)
      (tak (tak (- x 1) y z)
           (tak (- y 1) z x)
           (tak (- z 1) x y))
      z))

(define (benchmark-tak) (tak 18 12 6))

(define (gabriel-not value) (if value #f #t))

(define (shorterp x y)
  (and (gabriel-not (null? y))
       (or (null? x) (shorterp (cdr x) (cdr y)))))

(define (mas x y z)
  (if (shorterp y x)
      (mas (mas (cdr x) y z)
           (mas (cdr y) z x)
           (mas (cdr z) x y))
      z))

(define (benchmark-takl) (mas l18 l12 l6))

(define (shorterp-readable x y)
  (cond ((null? y) #f)
        ((null? x) #t)
        (else (shorterp-readable (cdr x) (cdr y)))))

(define (mas-readable x y z)
  (if (shorterp-readable y x)
      (mas-readable (mas-readable (cdr x) y z)
                    (mas-readable (cdr y) z x)
                    (mas-readable (cdr z) x y))
      z))

(define (benchmark-ntakl) (mas-readable l18 l12 l6))

(define (cpstak x y z)
  (letrec ((take
            (lambda (x y z continuation)
              (if (< y x)
                  (take (- x 1) y z
                        (lambda (first)
                          (take (- y 1) z x
                                (lambda (second)
                                  (take (- z 1) x y
                                        (lambda (third)
                                          (take first second third continuation)))))))
                  (continuation z)))))
    (take x y z (lambda (value) value))))

(define (benchmark-cpstak) (cpstak 12 6 3))

(define benchmarks
  (list (cons "deriv" benchmark-deriv)
        (cons "diviter" benchmark-diviter)
        (cons "divrec" benchmark-divrec)
        (cons "tak" benchmark-tak)
        (cons "takl" benchmark-takl)
        (cons "ntakl" benchmark-ntakl)
        (cons "cpstak" benchmark-cpstak)))

(define (check-results)
  (unless (equal? (benchmark-deriv) deriv-output) (error "deriv failed"))
  (unless (= (length (benchmark-diviter)) 500) (error "diviter failed"))
  (unless (= (length (benchmark-divrec)) 500) (error "divrec failed"))
  (unless (= (benchmark-tak) 7) (error "tak failed"))
  (unless (= (length (benchmark-takl)) 7) (error "takl failed"))
  (unless (= (length (benchmark-ntakl)) 7) (error "ntakl failed"))
  (unless (= (benchmark-cpstak) 4) (error "cpstak failed")))

(define sink #f)

(define (run-batch procedure operations)
  (let loop ((remaining operations) (result #f))
    (if (= remaining 0)
        (set! sink result)
        (loop (- remaining 1) (procedure)))))

(define (elapsed procedure operations)
  (let ((start (current-jiffy)))
    (run-batch procedure operations)
    (* 1000.0 (/ (- (current-jiffy) start) (jiffies-per-second)))))

(define (measure name procedure samples warmups operations)
  (let warm ((remaining warmups))
    (unless (= remaining 0)
      (run-batch procedure operations)
      (warm (- remaining 1))))
  (display "gabriel-result|")
  (display name)
  (display "|")
  (display operations)
  (let sample ((remaining samples))
    (unless (= remaining 0)
      (display "|")
      (display (/ (elapsed procedure operations) operations))
      (sample (- remaining 1))))
  (newline))

(define arguments (cdr (command-line)))
(unless (= (length arguments) 9) (error "expected samples, warmups, and seven iteration counts"))
(define samples (string->number (list-ref arguments 0)))
(define warmups (string->number (list-ref arguments 1)))
(define iteration-counts (map string->number (cddr arguments)))

(check-results)
(for-each
  (lambda (entry operations)
    (measure (car entry) (cdr entry) samples warmups operations))
  benchmarks
  iteration-counts)
