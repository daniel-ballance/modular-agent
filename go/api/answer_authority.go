package api

import "errors"

var ErrQuestionNotFound = errors.New("request closed or unknown")
var ErrAnswerAuthority = errors.New("answer authority refused")
var ErrInvalidAnswer = errors.New("invalid answer option")
var ErrMoveConflict = errors.New("move target is not quiescent")
var ErrCloseForbidden = errors.New("session close refused")
var ErrEraseForbidden = errors.New("erasure refused")
